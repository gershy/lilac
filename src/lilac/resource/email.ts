import capitalize from '../../../boot/util/capitalize';
import { TfEntity, TfResource } from '../provider/awsTf';
import { LambdaEmailKeeper } from '../comm/lambdaEmail/keep';
import { LambdaEmailViewer } from '../comm/lambdaEmail/view';
import { LambdaEmailMarker } from '../comm/lambdaEmail/mark';
import { Lilac, LilacContext } from '../lilac';
import { aws, tf } from '../util';
import { Domain } from './domain';
import { Lambda } from './lambda';
import { Storage } from './storage';

export type EmailAddr = `${string}@${string}.${string}`;
export type EmailArgs = {
  name: string,
  domain: Domain,
  testEmails?: EmailAddr[],
  storage?: Storage,
};
export class Email extends Lilac {
  protected name: string;
  protected domain: Domain;
  protected testEmails: EmailAddr[];
  protected storage: Storage;
  protected accessors: { mode: 'view' | 'mark' | 'keep', lambda: Lambda<any, any, any, any, any> }[];
  constructor(args: EmailArgs) {
    super();
    this.name = args.name;
    this.domain = args.domain;
    this.testEmails = args.testEmails ?? [];
    this.storage = args.storage ?? new Storage({ name: `${this.name}ReceiptStorage` });
    this.accessors = [];
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    yield* this.domain.getDependencies(ctx);
    yield* this.storage.getDependencies(ctx);
    for (const { lambda } of this.accessors) yield* lambda.getDependencies(ctx);
  }
  
  addAccessor(ctx: LilacContext, mode: 'view', lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaEmailViewer>;
  addAccessor(ctx: LilacContext, mode: 'mark', lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaEmailMarker>;
  addAccessor(ctx: LilacContext, mode: 'keep',  lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaEmailKeeper>;
  addAccessor(ctx: LilacContext, mode: 'view' | 'mark' | 'keep', lambda: Lambda<any, any, any, any, any>) {
    
    this.accessors.push({ mode, lambda });
    
    if (mode === 'keep') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaEmail/keep::LambdaEmailKeeper',
        form: LambdaEmailKeeper,
        args: [ { domain: this.domain.getNameBase() } ]
      } as JsfnInst<typeof LambdaEmailKeeper>;
      
    } else if (mode === 'view') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaEmail/view::LambdaEmailViewer',
        form: LambdaEmailViewer,
        args: [ { domain: this.domain.getNameBase() } ]
      } as JsfnInst<typeof LambdaEmailViewer>;
      
    } else if (mode === 'mark') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaEmail/mark::LambdaEmailMarker',
        form: LambdaEmailMarker,
        args: [ { domain: this.domain.getNameBase() } ]
      } as JsfnInst<typeof LambdaEmailMarker>;
      
    }
    
    throw Error('bad mode')[mod]({ mode });
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    // Some notes on DNS:
    //  - DNS servers may have tons of records (the ".com" TLD has a record for every ".com" site)
    //  - A DNS server uses "type" (A, CNAME, TXT, etc.) and "name" (some domain name reference) to
    //    resolve queries. You can ask a DNS server "get record whose type is X and domain is Y".
    //  - The stored "name" property is a bit dynamic. A DNS record may look like:
    //      | $ORIGIN example.com.
    //      | @                   IN A 100.101.102.103
    //      | *                   IN A 100.101.102.103
    //      | example.com.        IN A 100.101.102.103
    //      | x.example.com.      IN A 100.101.102.103
    //      | x                   IN A 100.101.102.103
    //      | x.y.z.example.com.  IN A 100.101.102.103
    //      | x.y.z               IN A 100.101.102.103
    //      | *.example.com.      IN A 100.101.102.103
    //      | *.x.example.com.    IN A 100.101.102.103
    //      | *.x                 IN A 100.101.102.103
    //  - Note that after the initial $ORIGIN line, the "name" is the first value per line.
    //  - Names ending with "." are considered "fully qualified". These should always end with the
    //    $ORIGIN (there's no reason that an $ORIGIN would be responsible for resolving domains
    //    that aren't nested under itself!)
    //  - The name can simply be "@", which maps exactly to the $ORIGIN value
    //  - The name can have "*" as a leftmost component (and nowhere else!); this translates to
    //    "all recursive subdomains", so "*.x" captures "a.b.c.z.y.x" as well as simply "y.x"
    
    const dns = (name: string, args: { [k: string]: any } & { type: string, relName: string }) => {
      
      const { type, relName, ...more } = args;
      return addEntity(new TfResource('awsRoute53Record', capitalize([ this.name, 'dns', name ]), {
        zoneId: hostedZone.tfRefp('zoneId'),
        ttl: 60 * 5,
        type: type[upper](),
        name: relName
          ? `${relName}.${tf.embed(domain.tfRef('domain'))}.`
          : `${tf.embed(domain.tfRef('domain'))}.`,
        ...more
      }));
      
    };
    
    // TODO: Prevent direct access to api gateway via public invoke url, use policies to prevent
    // requests from anywhere but cloudfront
    const entities = new Set<TfEntity>();
    const addEntity = <TE extends TfEntity>(ent: TE): TE => { entities.add(ent); return ent; };
    
    const hostedZone = this.domain.getHostedZone();
    const domainName = this.domain.getNameBase();
    
    const domain = addEntity(new TfResource('awsSesDomainIdentity', this.name, {
      domain: domainName // Consider using `getFullDomain`??
    }));
    const dkim = addEntity(new TfResource('awsSesDomainDkim', this.name, {
      domain: domain.tfRefp('domain')
    }));
    
    // strict
    // loose
    // sloppy
    
    const looseness: 2 | 1 | 0 = 2; // [ 2, 1, 0 ] signify increasing levels of strictness!
    const loosey = (...args: [ string, string, string ]) => args[looseness];
    
    // dkim involves email signing; it can be used to ensure content isn't altered
    const dkimDns = dns('dkim', {
      forEach: `| { for dkim in ${dkim.tfRef('dkimTokens')} : dkim => dkim }`,
      type: 'cname',
      relName: `${tf.embed('each.key')}._domainkey`,
      records: [ `${tf.embed('each.key')}.dkim.amazonses.com` ],
    });
    
    // spf involves restricting the range of ip addresses which are considered valid senders from
    // the given domain name; the following prevents any server outside ses from sending spoofed
    // emails from our domain
    const spfDns = dns('spf', {
      
      // TODO: This SPF setup applies only to the base domain; but adding in "*.domain.com." leads
      // to SPF configuration failing for *both* base and subdomains! I think the only way to get
      // SPF set up for subdomains is by using a separate hosted zone for each subdomain.......
      
      type: 'txt',
      forEach: `| toset(${JSON.stringify([ '', '*.' ])})`, // Apply spf to base and subdomains
      relName: '<<arbitrary>>', // util.tf.embed('each.value'),
      name: `${tf.embed('each.value')}${tf.embed(domain.tfRef('domain'))}.`, // Clobber the "name" derived from "relName"
      // relName: '',
      records: [ `v=spf1 include:amazonses.com ${loosey('-all', '~all', '?all')}` ]
      
    });
    
    // dmarc sort of combines dkim and spf - it determines how to handle combinations of results
    // from both (e.g. "spf passed but dkim failed"), and sets us up to receive reports on how our
    // email validation checks are working in the wild
    const dmarcDns = dns('dmarc', {
      type: 'txt',
      relName: `_dmarc`,
      records: [{
        
        v:     'dmarc1'[upper](),                       // dmarc version
        p:     loosey('reject', 'quarantine', 'none'), // policy - advice for email servers who received spoofed email
        sp:    loosey('reject', 'quarantine', 'none'), // subdomain policy
        aspf:  loosey('s', 'r', 'r'),                  // "strict" vs "relaxed"
        adkim: loosey('s', 'r', 'r'),                  // "strict" vs "relaxed"
        
        // "Reporting uris" for "aggregates" and "forensics"
        rua: `mailto:dmarc-report@${tf.embed(domain.tfRef('domain'))}`,
        ruf: `mailto:dmarc-report@${tf.embed(domain.tfRef('domain'))}`,
        
        // "Failure options"; requests email recipients to send us reports detailing why our sent emails fail; "1" means to inform us of failures if either spf and dmarc fail
        fo: (1).toString(10),
        
      }[toArr]((v, k) => `${k}=${v}`).join(';')]
    });
    
    // mx allows us to receive inbound mail
    const mxDns = dns('mx', {
      type: 'mx',
      relName: '',
      records: [`10 inbound-smtp.${ctx.aws.region}.amazonaws.com`]
    });
    
    // Expose our verification in a txt record
    const verificationDns = dns('verification', {
      type: 'txt',
      relName: '_amazonses',
      records: [ domain.tfRefp('verificationToken') ]
    });
    
    // This resource tells aws that we claim to have verified (by configuring dns records) a given
    // domain, for the purpose of email operations
    const verification = addEntity(new TfResource('awsSesDomainIdentityVerification', this.name, {
      domain: domain.tfRefp('id'),
      dependsOn: [ dkimDns.tfRefp() ]
    }));
    
    const bucket = this.storage.getBucket(ctx);
    const storageTfEnts = await this.storage.getTfEntities(ctx);
    for (const tfEnt of storageTfEnts) addEntity(tfEnt);
    
    // SES also needs explicit permission to write received emails to S3
    const writeS3Email = addEntity(new TfResource('awsS3BucketPolicy', this.name, {
      bucket: this.storage.getBucket(ctx).tfRefp('bucket'),
      policy: tf.json({ Version: '2012-10-17', Statement: [{
        
        Principal: { Service: 'ses.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': ctx.aws.accountId } },
        
        Effect: 'Allow',
        Action: 'S3:PutObject',
        Resource: [
          `${tf.embed(bucket.tfRef('arn'))}`,
          `${tf.embed(bucket.tfRef('arn'))}/*`
        ]
        
      }]})
    }));
    
    const receiptRules = addEntity(new TfResource('awsSesReceiptRuleSet', this.name, {
      ruleSetName: `${ctx.pfx}-inboundEmail`
    }));
    const receipt = addEntity(new TfResource('awsSesReceiptRule', this.name, {
      
      name: `${tf.embed(receiptRules.tfRef('ruleSetName'))}-s3Persist`,
      ruleSetName: receiptRules.tfRefp('ruleSetName'),
      enabled: true,
      
      recipients: [ this.domain.getNameBase() ], // Also supports e.g. "admin@domain.com"
      
      $s3Action: {
        position: 1,
        bucketName: bucket.tfRefp('bucket'),
        objectKeyPrefix: 'email/'
      },
      
      dependsOn: [ writeS3Email.tfRefp() ]
      
    }));
    const activeReceiptRules = addEntity(new TfResource('awsSesActiveReceiptRuleSet', this.name, {
      ruleSetName: receiptRules.tfRefp('ruleSetName'),
    }));
    
    // Set up test emails
    for (const emailAddr of this.testEmails)
      addEntity(new TfResource('awsSesEmailIdentity', `${this.name}_${emailAddr.replace(/[^a-zA-Z0-9]/g, '_')[lower]()}`, {
        email: emailAddr
      }));
    
    // Consider dedicated ip addresses for SES (configurable via tf??)
    // - Costs about $3.60 / month ($0.005 / hr)
    // With dedicated ip addresses, set up PTR dns records to map the ip addresses to domain names
    // Add BIMI TXT record for brand logo????
    
    /*
    // Consider including this stuff: bounce, complaint, delivery
    const sesNotificationHandler = addEntity(new TfResource('awsSnsTopic', this.name + 'Notifier', {
      // ......
    }));
    
    const notifyBounce = addEntity(new TfResource('awsSesIdentityNotificationTopic', this.name + 'NotifyBounce', {
      identity: domain.tfRefp('domain'),
      notificationType: capitalize('bounce'),
      topicArn: sesNotificationHandler.tfRefp('arn')
    }));
    const notifyComplaint = addEntity(new TfResource('awsSesIdentityNotificationTopic', this.name + 'NotifyComplaint', {
      identity: domain.tfRefp('domain'),
      notificationType: capitalize('complaint'),
      topicArn: sesNotificationHandler.tfRefp('arn')
    }));
    const notifyDelivery = addEntity(new TfResource('awsSesIdentityNotificationTopic', this.name + 'NotifyDelivery', {
      identity: domain.tfRefp('domain'),
      notificationType: capitalize('delivery'),
      topicArn: sesNotificationHandler.tfRefp('arn')
    }));
    */
    
    for (const { mode, lambda } of this.accessors) {
      
      const roleTfEnt = await lambda.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
      
      const lambdaPolicyName = capitalize([ 'email', lambda.getName(), this.name ]);
      const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
        name: `${ctx.pfx}-${lambdaPolicyName}`,
        
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          effect: capitalize('allow'),
          action: [
            ...([ 'view', 'keep' ][has](mode) ? [ 'ses:ReceiveEmail', 'ses:ReceiveRawEmail' ] : []), // TODO: I made up those action names!! Look into receiving email...
            ...([ 'mark', 'keep' ][has](mode) ? [ 'ses:SendEmail', 'ses:SendRawEmail' ] : []),
          ],
          
          // The ses "domain" is the resource which actually processes email
          resource: [
            `${tf.embed(domain.tfRef('arn'))}`,
            `${tf.embed(domain.tfRef('arn'))}/*`,
            `${tf.embed(`FIRST_DOMAIN_COMPONENT`)}/*` // Note the fixed string is used for substitution
          ]
        }]}))
          .replace('FIRST_DOMAIN_COMPONENT', `element(split("/", ${domain.tfRef('arn')}), 0)`)
        
      }));
      
      const lambdaPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      roleTfEnt.tfRefp('name'),
        policyArn: lambdaPolicy.tfRefp('arn')
      }));
      
    }
    
    return [ ...entities ];
    
  }
  
};
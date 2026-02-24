import capitalize from '../../../boot/util/capitalize';
import { Lilac, LilacContext } from '../lilac';
import { TfData, TfEntity, TfResource } from '../provider/awsTf';
import { Service } from '../registry/registry';

export class Vpc extends Lilac {
  
  // Reducing aws costs using vpc is a bit tricky. The main concepts are:
  // - There are 3 kinds of ways lambdas can talk to services:
  //   1. Via public internet (e.g. via http client)
  //   2. Via aws vpc "gateway" - free, for ddb and s3 only
  //   3. Via aws vpc "interface" - cheap (~$7/mo + usage), for other aws services
  // - Note the last 2 types can *also* be accessed via the public internet
  // - It's cheaper for lamdbas to interact with gateway-type services via a vpc (data never leaves
  //   aws), vs the public internet
  // - But, once a lambda is in the vpc it no longer has public internet access
  //   - It can only gain public internet access via a nat setup, which is expensive - ~$32/mo,
  //     plus a lot more depending on data load
  //   - And any aws services it uses apart from ddb/s3 will require an interface, which is cheap
  //     but not free
  // - Overall, for a lambda that interacts with aws gateway services and other service types, the
  //   savings from adding vpc will typically be outweighed by nat/interface charges unless aws
  //   service data usage is very high (e.g. lots of public internet io with ddb/s3), and other
  //   public internet data + interface service use is low
  // - So the typical plan should be:
  //   1. Never use nat
  //   2. Lambdas which only use aws gateway services (most lambdas!) should go in the vpc
  //   3. Lambdas which require public internet or interface service go *outside* the vpc - they
  //      can still interact with aws services via their public regional endpoints!
  
  private name: string;
  private freeStorage: boolean;
  private freeDocDb: boolean;
  private cheapEmail: boolean;
  private cheapQueue: boolean;
  private expensiveW3: boolean;
  
  constructor(args: { name: string, freeStorage: boolean, freeDocDb: boolean, cheapEmail: boolean, cheapQueue: boolean, expensiveW3: boolean }) {
    
    super();
    this.name = args.name;
    this.freeStorage = args.freeStorage;
    this.freeDocDb = args.freeDocDb;
    this.cheapEmail = args.cheapEmail;
    this.cheapQueue = args.cheapQueue;
    this.expensiveW3 = args.expensiveW3;
    
  }

  public getConfig() {
    return {
      storage: this.freeStorage,
      docDb:   this.freeDocDb,
      email:   this.cheapEmail,
      queue:   this.cheapQueue,
      w3:      this.expensiveW3
    } satisfies { [K in Service]: any };
  }
  
  async getTfEntities0(ctx: LilacContext) {
    const entities: TfEntity[] = [];
    const addEntity = (ent: TfEntity) => { entities.push(ent); return ent; };
    
    const name = `${this.name}Vpc`;
    
    const zones = addEntity(new TfData('awsAvailabilityZones', name, { state: 'available' }));
    const vpc = addEntity(new TfResource('awsVpc', name, {
      cidrBlock: '10.0.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: true
    }));
    
    // Note it's good to have redundancy in private subnets
    // All aws regions have at least 2 availability zones!
    const numPrivateSubnets = 2;
    const privateSubnets = numPrivateSubnets[toArr](n => {

      const subnet = addEntity(new TfResource('awsSubnet', `${name}Private${n}`, {
        vpcId: vpc.tfRefp('id'),
        cidrBlock: `10.0.${n + 1}.0/24`,
        availabilityZone: `| ${zones.tfRef('names')}[${n}]`,
      }));
      
      // The subnet needs to be associated with a route table; we're using the vpc's default route
      // table which should be sufficient unless our use-cases grow more complex
      const assoc = addEntity(new TfResource('awsRouteTableAssociation', `${name}Private${n}`, {
        subnetId: subnet.tfRefp('id'),
        routeTableId: vpc.tfRefp('defaultRouteTableId')
      }));
      
      return { subnet, assoc };
    });
    
    const securityGroup = addEntity(new TfResource('awsSecurityGroup', name, {
      name: `${this.name}SecurityGroup`,
      vpcId: vpc.tfRefp('id'),
      
      $egress: {
        fromPort: 0,
        toPort: 0,
        protocol: '-1',
        cidrBlocks: [ '0.0.0.0/0' ]
      }
      
    }));
    
    // Note "free" is possible for "gateway-type" services; these use a fixed routing table to
    // make the service addressable within the vpc
    const freeStuff = [
      { name: `${name}DocDb`,   awsSubdomain: 'dynamodb', active: this.freeDocDb   },
      { name: `${name}Storage`, awsSubdomain: 's3',       active: this.freeStorage },
    ];
    for (const { name, awsSubdomain, active } of freeStuff)
      if (active)
        addEntity(new TfResource('awsVpcEndpoint', name, {
          vpcId: vpc.tfRefp('id'),
          serviceName: `com.amazonaws.${ctx.aws.region}.${awsSubdomain}`,
          vpcEndpointType: capitalize('gateway'), // Gateways are free!
          routeTableIds: [ vpc.tfRefp('defaultRouteTableId') ]
        }));
    
    // Note "cheap" is possible for "interface-type" services; these require more stateful
    // connection management, with security groups to differentiate semantically different requests
    const cheapStuff = [
      { name: `${name}Queue`, awsSubdomain: 'sqs', active: this.cheapQueue },
      { name: `${name}Email`, awsSubdomain: 'ses', active: this.cheapEmail },
    ];
    for (const { name, awsSubdomain, active } of cheapStuff)
      if (active)
        addEntity(new TfResource('awsVpcEndpoint', name, {
          vpcId: vpc.tfRefp('id'),
          serviceName: `com.amazonaws.${ctx.aws.region}.${awsSubdomain}`,
          vpcEndpointType: capitalize('interface'), // Interfaces are cheap, but not free
          subnetIds: privateSubnets.map(ps => ps.subnet.tfRefp('id')),
          securityGroupIds: [ securityGroup.tfRefp('id') ],
          privateDnsEnabled: true
        }));

    if (this.expensiveW3) {
      
      throw Error('not implemented');
      
      /* Need to provision a lot in this case...
        
        // A subnet with internet access to host the nat gateway
        resource "aws_internet_gateway" "main" {
          vpc_id = aws_vpc.main.id
        }
        
        resource "aws_subnet" "public_a" {
          vpc_id                  = aws_vpc.main.id
          cidr_block              = "10.0.0.0/24"
          availability_zone       = "us-east-1a"
          map_public_ip_on_launch = true
        }
        
        resource "aws_route_table" "public" {
          vpc_id = aws_vpc.main.id
          
          route {
            cidr_block = "0.0.0.0/0"
            gateway_id = aws_internet_gateway.main.id
          }
        }
        
        resource "aws_route_table_association" "public_a" {
          subnet_id      = aws_subnet.public_a.id
          route_table_id = aws_route_table.public.id
        }
        
        // Managed service that lets private subnets reach the internet
        resource "aws_eip" "nat" {
          vpc = true
        }
        
        resource "aws_nat_gateway" "main" {
          allocation_id = aws_eip.nat.id
          subnet_id     = aws_subnet.public_a.id
        }
        
        // Provide a route from the private subnet to the nat gateway
        resource "aws_subnet" "private_a" {
          vpc_id            = aws_vpc.main.id
          cidr_block        = "10.0.1.0/24"
          availability_zone = "us-east-1a"
        }
        
        resource "aws_route_table" "private_a" {
          vpc_id = aws_vpc.main.id
          
          route {
            cidr_block     = "0.0.0.0/0"
            nat_gateway_id = aws_nat_gateway.main.id
          }
        }
        
        resource "aws_route_table_association" "private_a" {
          subnet_id      = aws_subnet.private_a.id
          route_table_id = aws_route_table.private_a.id
        }
      */
      
    }
    
    return entities;
  }
  
}
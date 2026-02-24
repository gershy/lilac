import { Logger } from '../../boot/util/logger';
import { Throttler } from '../../boot/util/throttler';
import { AccessKey } from '../util/config';
import { FilesysEntity as Db } from '../util/db';
import { TfEntity } from './provider/awsTf';

// TODO: Watch out when working lilac into an npm dependency, need to allow the user a way to
// declare their absolute repo path (so "<repo>/..." filenames work in any setup!)

// TODO: This context actually has nothing to do with Lilac - it's really just "everything needed
// to run the app". It should possibly just authoritatively be named... "Ctx"?? And live higher up?
export type LilacContext = {
  logger: Logger,
  repoDb: Db,
  
  aws: { accountId: string, accessKey: AccessKey, region: string },
  
  term: string,
  maturity: string,
  debug: boolean,
  
  // The prefix establishes a namespace for all resources provisioned for the particular app
  pfx: string,
  
  // Throttlers:
  // - webpack: shell "webpack" commands
  // - zipFile: jszipping files
  throttlers: { [K in 'webpack' | 'zipFile']: Throttler }
};

export class Lilac {
  private mem: null | Promise<TfEntity[]>;
  constructor() {
    this.mem = null;
  }
  public * getDependencies(ctx: LilacContext): Generator<Lilac> {
    yield this;
  }
  protected async getTfEntities0(ctx: LilacContext): Promise<TfEntity[]> {
    throw Error('not implemented');
  }
  public async getTfEntities(ctx: LilacContext): Promise<TfEntity[]> {
    if (!this.mem) this.mem = this.getTfEntities0(ctx);
    return this.mem;
  }
};

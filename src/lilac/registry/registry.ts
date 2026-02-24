import { DocDb } from '../resource/docDb';
import { Domain } from '../resource/domain';
import { Email } from '../resource/email';
import { HttpGateway } from '../resource/httpGateway';
import { LambdaHttp, LambdaQueue } from '../resource/lambda';
import { Queue } from '../resource/queue';
import { Role } from '../resource/role';
import { Storage } from '../resource/storage';
import { Vpc } from '../resource/vpc';

export type LilacRegistry = typeof registry;
export type Service = 'storage' | 'docDb' | 'queue' | 'email' | 'w3';
export const registry = {
  Vpc,
  LambdaHttp,
  LambdaQueue,
  DocDb,
  Domain,
  HttpGateway,
  Storage,
  Queue,
  Email,
  Role,
};
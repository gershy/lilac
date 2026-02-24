// Currently queues can only be marked, hence the keeper is the marker!
import { LambdaQueueMarker } from './mark';

export class LambdaQueueKeeper<Args extends Json> extends LambdaQueueMarker<Args> {}
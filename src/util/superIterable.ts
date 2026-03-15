// Iterate a SuperIterable using (note the `for await`, and `await superIterable`):
//    | 
//    | for await (const val of await superIterable)
//    |   console.log(val);
//    | 
export type SuperIterable<T> = Iterable<T> | Promise<Iterable<T>> | AsyncIterable<T>;

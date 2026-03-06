export type TryWithHealingArgs<T> = {
  fn: () => Promise<T>,
  canHeal: (err: any) => boolean,
  heal: () => Promise<any>
};
export default async <T>(args: TryWithHealingArgs<T>): Promise<T> => {
  
  const { fn, heal, canHeal } = args;
  
  return fn().catch(async err => {
    if (!canHeal(err)) throw err;
    await heal();
    return fn();
  });
  
};
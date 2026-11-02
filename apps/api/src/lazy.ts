/**
 * An object that is built on first use. Properties are read from the built object, and its methods keep it as `this`, so
 * the stand-in can be handed to code that expects the real object. Built at most once.
 */
export function lazy<T extends object>(build: () => T): T {
  let value: T | undefined;
  const target = () => (value ??= build());
  return new Proxy({} as T, {
    get(_, key) {
      const object = target();
      const v = Reflect.get(object, key, object);
      return typeof v === "function" ? v.bind(object) : v;
    },
    has: (_, key) => Reflect.has(target(), key),
    ownKeys: () => Reflect.ownKeys(target()),
    getOwnPropertyDescriptor(_, key) {
      const d = Reflect.getOwnPropertyDescriptor(target(), key);
      return d && { ...d, configurable: true };
    },
  });
}

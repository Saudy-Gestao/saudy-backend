/**
 * Guarantees the members our code actually uses exist on the global fetch API
 * types, via TypeScript interface merging. Necessary because the ambient
 * `fetch`/`Response`/`Headers` declarations that come from @types/node
 * (undici-types) resolve inconsistently between this machine and Vercel's
 * build container — merging here is additive, so it's safe regardless of
 * which underlying declaration wins.
 */
export {};

declare global {
  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    readonly body: ReadableStream<Uint8Array> | null;
    json(): Promise<any>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  interface Headers {
    get(name: string): string | null;
    has(name: string): boolean;
    forEach(callback: (value: string, key: string) => void): void;
  }

  function fetch(input: any, init?: any): Promise<Response>;
}

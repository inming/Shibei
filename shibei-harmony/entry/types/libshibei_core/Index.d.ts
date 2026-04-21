// GENERATED — do not edit by hand.
// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.

export const init: (dataDir: string) => string;
export const isInitialized: () => boolean;
export const hasSavedConfig: () => boolean;
export const isUnlocked: () => boolean;
export const lockVault: () => void;
export const hello: () => string;
export const add: (a: number, b: number) => number;
export const s3SmokeTest: (endpoint: string, region: string, bucket: string, accessKey: string, secretKey: string) => string;
export const echoAsync: (text: string) => Promise<string>;
export const onTick: (intervalMs: number, cb: (payload: number) => void) => () => void;

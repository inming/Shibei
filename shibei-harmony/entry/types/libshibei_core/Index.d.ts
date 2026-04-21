// GENERATED — do not edit by hand.
// Run `cargo run -p shibei-napi-codegen` after editing commands.rs.

export const initApp: (dataDir: string) => string;
export const isInitialized: () => boolean;
export const hasSavedConfig: () => boolean;
export const isUnlocked: () => boolean;
export const lockVault: () => void;
export const setS3Config: (configJson: string) => string;
export const setE2eePassword: (password: string) => Promise<string>;
export const syncMetadata: () => Promise<string>;
export const listFolders: () => string;
export const listResources: (folderId: string, tagIdsJson: string, sortJson: string) => string;
export const searchResources: (query: string, tagIdsJson: string) => string;
export const listTags: () => string;
export const getResource: (id: string) => string;
export const getResourceSummary: (id: string, maxChars: number) => string;
export const hello: () => string;
export const add: (a: number, b: number) => number;
export const s3SmokeTest: (endpoint: string, region: string, bucket: string, accessKey: string, secretKey: string) => string;
export const echoAsync: (text: string) => Promise<string>;
export const onTick: (intervalMs: number, cb: (payload: number) => void) => () => void;

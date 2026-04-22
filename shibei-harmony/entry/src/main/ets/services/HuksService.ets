// shibei-harmony/entry/src/main/ets/services/HuksService.ets
//
// Wraps @kit.UniversalKeystoreKit (HUKS) for Phase 4 lock screen. Two keys:
//
//   shibei_device_bound_v1 — AES-256-GCM, no userAuth. Used for S3 creds
//                            and (via wrap/unwrap) any blob that needs to
//                            die when the device does.
//   shibei_bio_kek_v1      — AES-256-GCM, userAuth=FINGERPRINT|FACE,
//                            authAccessType=INVALID_NEW_BIO_ENROLL, ATL2.
//
// HUKS AES-GCM `finishSession` returns `ct || tag` (16-byte tag appended);
// for decrypt we must split them and feed AE_TAG separately.
// We serialise blobs as JSON `{iv: base64, ct: base64}` so unwrap can feed
// HUKS back the right pieces.

import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DEVICE_ALIAS = 'shibei_device_bound_v1';
const BIO_ALIAS = 'shibei_bio_kek_v1';
const IV_LEN = 12;   // HUKS AES-GCM requires 12-byte IV
const TAG_LEN = 16;  // HUKS AES-GCM tag (split off outData on decrypt)

interface CipherBlob {
  iv: string;
  ct: string;
}

export class HuksService {
  private static _instance: HuksService | null = null;
  static get instance(): HuksService {
    if (!HuksService._instance) HuksService._instance = new HuksService();
    return HuksService._instance;
  }

  // ── Device-bound key (no auth) ─────────────────────────────

  async ensureDeviceKey(): Promise<void> {
    const exists = await this.hasKey(DEVICE_ALIAS);
    if (exists) return;
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value:
          huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
    ];
    await huks.generateKeyItem(DEVICE_ALIAS, { properties: props });
  }

  async wrapDeviceBound(plainB64: string): Promise<string> {
    await this.ensureDeviceKey();
    const encoder = new util.Base64Helper();
    const pt = encoder.decodeSync(plainB64);
    const iv = this.randomIv();
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, { properties: props, inData: pt });
    const outData = finished.outData ?? new Uint8Array();
    const blob: CipherBlob = {
      iv: encoder.encodeToStringSync(iv),
      ct: encoder.encodeToStringSync(outData),
    };
    const blobBytes = new util.TextEncoder().encodeInto(JSON.stringify(blob));
    return encoder.encodeToStringSync(blobBytes);
  }

  async unwrapDeviceBound(outerB64: string): Promise<string> {
    const encoder = new util.Base64Helper();
    const outerBytes = encoder.decodeSync(outerB64);
    const blob: CipherBlob = JSON.parse(new util.TextDecoder('utf-8').decodeToString(outerBytes)) as CipherBlob;
    const iv = encoder.decodeSync(blob.iv);
    const ctAll = encoder.decodeSync(blob.ct);
    if (ctAll.byteLength < TAG_LEN) {
      throw new Error('error.secureStoreCorrupted: ct too short');
    }
    const ctBody = ctAll.slice(0, ctAll.byteLength - TAG_LEN);
    const tag = ctAll.slice(ctAll.byteLength - TAG_LEN);
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
      { tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: tag },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, { properties: props, inData: ctBody });
    const pt = finished.outData ?? new Uint8Array();
    return encoder.encodeToStringSync(pt);
  }

  // ── Bio-gated key ──────────────────────────────────────────

  async isBioAvailable(): Promise<boolean> {
    // getAvailableStatus returns void and throws a BusinessError when the
    // requested mode isn't available (no enrolled biometric, hardware
    // missing, etc.). So "no throw" means available.
    try {
      userAuth.getAvailableStatus(
        userAuth.UserAuthType.FINGERPRINT,
        userAuth.AuthTrustLevel.ATL2,
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  async hasBioKey(): Promise<boolean> {
    return this.hasKey(BIO_ALIAS);
  }

  /// Generate the bio-gated AES-256-GCM key. Must be called after the user
  /// has at least one biometric enrolled, otherwise HUKS rejects the
  /// INVALID_NEW_BIO_ENROLL attribute.
  async generateBioKey(): Promise<void> {
    await this.deleteBioKey(); // idempotent, no-throw if missing
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value:
          huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE, value:
          huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE },
      { tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE,
        value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL },
      { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL },
    ];
    await huks.generateKeyItem(BIO_ALIAS, { properties: props });
  }

  async deleteBioKey(): Promise<void> {
    try { await huks.deleteKeyItem(BIO_ALIAS, { properties: [] }); }
    catch (e) { /* not found is fine */ }
  }

  /// Wrap `plainB64` using the bio-gated key. Caller MUST have just done a
  /// userAuth.authV9() successfully — HUKS challenge_type=NORMAL ties the
  /// operation handle to the auth token. Returns base64 of `{iv,ct}` JSON.
  async wrapBio(plainB64: string, authToken: Uint8Array): Promise<string> {
    return this.bioCipher(plainB64, authToken, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT);
  }

  async unwrapBio(wrappedB64: string, authToken: Uint8Array): Promise<string> {
    return this.bioCipher(wrappedB64, authToken, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT);
  }

  // ── internals ──────────────────────────────────────────────

  private async bioCipher(inputB64: string, authToken: Uint8Array, purpose: number): Promise<string> {
    const encoder = new util.Base64Helper();
    if (purpose === huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT) {
      const pt = encoder.decodeSync(inputB64);
      const iv = this.randomIv();
      const props: huks.HuksParam[] = [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
        { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
        { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
        { tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken },
      ];
      const handle = await huks.initSession(BIO_ALIAS, { properties: props });
      const finished = await huks.finishSession(handle.handle, { properties: props, inData: pt });
      const outData = finished.outData ?? new Uint8Array();
      const blob: CipherBlob = {
        iv: encoder.encodeToStringSync(iv),
        ct: encoder.encodeToStringSync(outData),
      };
      return encoder.encodeToStringSync(new util.TextEncoder().encodeInto(JSON.stringify(blob)));
    } else {
      const wrappedBytes = encoder.decodeSync(inputB64);
      const blob: CipherBlob = JSON.parse(new util.TextDecoder('utf-8').decodeToString(wrappedBytes)) as CipherBlob;
      const iv = encoder.decodeSync(blob.iv);
      const ctAll = encoder.decodeSync(blob.ct);
      if (ctAll.byteLength < TAG_LEN) {
        throw new Error('error.secureStoreCorrupted: bio ct too short');
      }
      const ctBody = ctAll.slice(0, ctAll.byteLength - TAG_LEN);
      const tag = ctAll.slice(ctAll.byteLength - TAG_LEN);
      const props: huks.HuksParam[] = [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
        { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
        { tag: huks.HuksTag.HUKS_TAG_IV, value: iv },
        { tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: tag },
        { tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken },
      ];
      const handle = await huks.initSession(BIO_ALIAS, { properties: props });
      const finished = await huks.finishSession(handle.handle, { properties: props, inData: ctBody });
      return encoder.encodeToStringSync(finished.outData ?? new Uint8Array());
    }
  }

  private randomIv(): Uint8Array {
    const iv = new Uint8Array(IV_LEN);
    for (let i = 0; i < IV_LEN; i++) {
      iv[i] = Math.floor(Math.random() * 256);
    }
    return iv;
  }

  private async hasKey(alias: string): Promise<boolean> {
    try {
      const exists = await huks.isKeyItemExist(alias, { properties: [] });
      return exists === true;
    } catch (e) { return false; }
  }
}

/// Bundle handed by UserAuth → HuksService for bio operations. authToken
/// lives ~5 seconds on the HUKS side; reuse is not safe across that window.
export interface BioAuthBundle {
  authToken: Uint8Array;
  challenge: Uint8Array;
}

/// Prompt the user for fingerprint/face and return the authToken. Throws if
/// the user cancels or the device doesn't support the requested level.
export async function requestBioAuth(): Promise<BioAuthBundle> {
  const challenge = new Uint8Array(32);
  for (let i = 0; i < 32; i++) challenge[i] = Math.floor(Math.random() * 256);
  const auth = userAuth.getAuthInstance(
    challenge,
    userAuth.UserAuthType.FINGERPRINT,
    userAuth.AuthTrustLevel.ATL2,
  );
  return new Promise<BioAuthBundle>((resolve, reject) => {
    // AuthEvent is an object with a `callback(result: AuthResultInfo)` method,
    // not a bare function. `AuthResultInfo.result` carries the code; `.token`
    // is the auth token when result === SUCCESS.
    const authEvent: userAuth.AuthEvent = {
      callback: (info: userAuth.AuthResultInfo): void => {
        if (info.result === userAuth.ResultCode.SUCCESS) {
          resolve({ authToken: info.token ?? new Uint8Array(), challenge });
        } else {
          hilog.warn(0x0000, 'shibei', 'bio auth failed: %{public}d', info.result);
          reject(new Error(`error.bioAuthFailed:${info.result}`));
        }
      },
    };
    auth.on('result', authEvent);
    try { auth.start(); }
    catch (e) { reject(e as Error); }
  });
}

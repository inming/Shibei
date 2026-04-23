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
//
// Blob layout on disk (base64-encoded for transport across NAPI):
//   [IV(12 bytes) | CT(N bytes) | TAG(16 bytes)]
// A binary concat is used instead of a JSON `{iv,ct}` wrapper so we avoid
// `util.TextEncoder` / `util.TextDecoder` — in some NEXT SDK builds
// `new util.TextDecoder(...)` returns undefined, tripping "undefined is
// not callable" at runtime.

import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DEVICE_ALIAS = 'shibei_device_bound_v1';
const BIO_ALIAS = 'shibei_bio_kek_v1';
const IV_LEN = 12;   // HUKS AES-GCM requires 12-byte IV
const TAG_LEN = 16;  // HUKS AES-GCM tag (split off outData on decrypt)

/// Fixed AAD for AES-GCM. HUKS's AES/GCM/NoPadding mode requires the
/// HUKS_TAG_ASSOCIATED_DATA param even if unused; a zero-length blob
/// isn't accepted by all ROMs, so use a short fixed byte string.
const AAD = new Uint8Array([0x73, 0x68, 0x69, 0x62, 0x65, 0x69]); // "shibei"

/// Concat [iv | body]. Returns a fresh Uint8Array.
function concatIvBody(iv: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(iv.byteLength + body.byteLength);
  out.set(iv, 0);
  out.set(body, iv.byteLength);
  return out;
}

/// Split base64'd blob into (iv, ctBody, tag). Throws if shorter than
/// iv+tag minimum.
function splitIvCtTag(blobBytes: Uint8Array): IvCtTag {
  if (blobBytes.byteLength < IV_LEN + TAG_LEN) {
    throw new Error('error.secureStoreCorrupted: blob too short');
  }
  const iv = blobBytes.slice(0, IV_LEN);
  const rest = blobBytes.slice(IV_LEN);
  const tag = rest.slice(rest.byteLength - TAG_LEN);
  const ctBody = rest.slice(0, rest.byteLength - TAG_LEN);
  return { iv, ctBody, tag };
}

interface IvCtTag {
  iv: Uint8Array;
  ctBody: Uint8Array;
  tag: Uint8Array;
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
    // Match the HUKS AES/GCM unit-test pattern (security_huks repo,
    // hks_access_control_test_common.cpp g_authtokenAesParams):
    // ALGORITHM, KEY_SIZE, PURPOSE, PADDING, DIGEST=NONE, BLOCK_MODE=GCM,
    // ASSOCIATED_DATA, NONCE. Same props are reused for init + finish.
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_DIGEST, value: huks.HuksKeyDigest.HUKS_DIGEST_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA, value: AAD },
      { tag: huks.HuksTag.HUKS_TAG_NONCE, value: iv },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, { properties: props, inData: pt });
    const outData = finished.outData ?? new Uint8Array();
    // Binary layout: [IV | CT || TAG]. outData already contains CT||TAG.
    return encoder.encodeToStringSync(concatIvBody(iv, outData));
  }

  async unwrapDeviceBound(outerB64: string): Promise<string> {
    const encoder = new util.Base64Helper();
    const blobBytes = encoder.decodeSync(outerB64);
    const parts = splitIvCtTag(blobBytes);
    // Decrypt side: same base as encrypt + AE_TAG at the end.
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_DIGEST, value: huks.HuksKeyDigest.HUKS_DIGEST_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA, value: AAD },
      { tag: huks.HuksTag.HUKS_TAG_NONCE, value: parts.iv },
      { tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: parts.tag },
    ];
    const handle = await huks.initSession(DEVICE_ALIAS, { properties: props });
    const finished = await huks.finishSession(handle.handle, { properties: props, inData: parts.ctBody });
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

  /// Wrap `plainB64` using the bio-gated key. Runs the full
  /// init → user-auth-with-HUKS-challenge → finish flow internally; caller
  /// does NOT pre-authenticate. CHALLENGE_TYPE_NORMAL requires the user-auth
  /// token be bound to the exact challenge HUKS minted during initSession,
  /// so we cannot reuse a pre-existing token. Returns base64 of `{iv,ct}` JSON.
  async wrapBio(plainB64: string): Promise<string> {
    return this.bioCipher(plainB64, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT);
  }

  async unwrapBio(wrappedB64: string): Promise<string> {
    return this.bioCipher(wrappedB64, huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT);
  }

  // ── internals ──────────────────────────────────────────────

  private async bioCipher(inputB64: string, purpose: number): Promise<string> {
    hilog.info(0x0000, 'shibei', 'bioCipher: entry purpose=%{public}d inputLen=%{public}d',
      purpose, inputB64.length);
    const encoder = new util.Base64Helper();
    hilog.info(0x0000, 'shibei', 'bioCipher: Base64Helper ok');
    const isEncrypt = purpose === huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT;

    // Step 1: pick IV + build inData + optional TAG from the binary blob.
    let iv: Uint8Array;
    let tag: Uint8Array | null = null;
    let inData: Uint8Array;
    if (isEncrypt) {
      iv = this.randomIv();
      inData = encoder.decodeSync(inputB64);
      hilog.info(0x0000, 'shibei', 'bioCipher: encrypt prep iv=%{public}d pt=%{public}d',
        iv.byteLength, inData.byteLength);
    } else {
      const blobBytes = encoder.decodeSync(inputB64);
      hilog.info(0x0000, 'shibei', 'bioCipher: decoded blobBytes=%{public}d', blobBytes.byteLength);
      const parts = splitIvCtTag(blobBytes);
      iv = parts.iv;
      inData = parts.ctBody;
      tag = parts.tag;
      hilog.info(0x0000, 'shibei', 'bioCipher: split iv=%{public}d ct=%{public}d tag=%{public}d',
        iv.byteLength, inData.byteLength, tag.byteLength);
    }

    // HUKS AES/GCM param set — matches security_huks unit test pattern
    // (g_authtokenAesParams). Shared between init+finish. AE_TAG appended
    // on decrypt. AUTH_TOKEN is added in a separate finishProps below.
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_DIGEST, value: huks.HuksKeyDigest.HUKS_DIGEST_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_ASSOCIATED_DATA, value: AAD },
      { tag: huks.HuksTag.HUKS_TAG_NONCE, value: iv },
    ];
    if (!isEncrypt && tag) {
      props.push({ tag: huks.HuksTag.HUKS_TAG_AE_TAG, value: tag });
    }

    hilog.info(0x0000, 'shibei', 'bioCipher: calling initSession');
    const handle = await huks.initSession(BIO_ALIAS, { properties: props });
    hilog.info(0x0000, 'shibei', 'bioCipher: initSession ok handle=%{public}d', handle.handle);
    const hukschallenge: Uint8Array = handle.challenge ?? new Uint8Array();
    if (hukschallenge.byteLength === 0) {
      throw new Error('error.secureStoreCorrupted: HUKS returned no challenge');
    }

    // Step 3: prompt user for biometric with HUKS-minted challenge.
    hilog.info(0x0000, 'shibei', 'bioCipher: requesting bio auth, challenge=%{public}d',
      hukschallenge.byteLength);
    const authToken = await requestBioAuthForChallenge(hukschallenge);
    hilog.info(0x0000, 'shibei', 'bioCipher: auth ok token=%{public}d', authToken.byteLength);

    // finishSession adds AUTH_TOKEN on top of the same shared props.
    const finishProps: huks.HuksParam[] = [...props,
      { tag: huks.HuksTag.HUKS_TAG_AUTH_TOKEN, value: authToken },
    ];
    const finished = await huks.finishSession(handle.handle, { properties: finishProps, inData });
    hilog.info(0x0000, 'shibei', 'bioCipher: finishSession ok out=%{public}d',
      finished.outData?.byteLength ?? 0);
    const outData = finished.outData ?? new Uint8Array();

    if (isEncrypt) {
      // Binary layout [IV | CT || TAG]. outData already has CT||TAG.
      return encoder.encodeToStringSync(concatIvBody(iv, outData));
    } else {
      return encoder.encodeToStringSync(outData);
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

/// Prompt the user for fingerprint auth using a HUKS-minted challenge and
/// return just the auth token. The challenge MUST come from a HUKS
/// `initSession` handle when the target key was generated with
/// CHALLENGE_TYPE_NORMAL — otherwise HUKS `finishSession` rejects the token
/// with ret=-43 (HksParamSet send fail).
///
/// Uses HarmonyOS NEXT `getUserAuthInstance(AuthParam, WidgetParam)` — the
/// legacy `getAuthInstance` can't render the system sheet on NEXT.
export async function requestBioAuthForChallenge(challenge: Uint8Array): Promise<Uint8Array> {
  const authParam: userAuth.AuthParam = {
    challenge,
    authType: [userAuth.UserAuthType.FINGERPRINT],
    authTrustLevel: userAuth.AuthTrustLevel.ATL2,
  };
  const widgetParam: userAuth.WidgetParam = {
    title: '验证身份以解锁拾贝',
  };
  const auth = userAuth.getUserAuthInstance(authParam, widgetParam);
  return new Promise<Uint8Array>((resolve, reject) => {
    auth.on('result', {
      onResult: (result: userAuth.UserAuthResult): void => {
        if (result.result === userAuth.UserAuthResultCode.SUCCESS) {
          resolve(result.token ?? new Uint8Array());
        } else {
          hilog.warn(0x0000, 'shibei', 'bio auth failed: %{public}d', result.result);
          reject(new Error(`error.bioAuthFailed:${result.result}`));
        }
      },
    });
    try { auth.start(); }
    catch (e) { reject(e as Error); }
  });
}

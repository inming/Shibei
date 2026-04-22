// shibei-harmony/entry/src/main/ets/app/HuksSpike.ets
import { huks } from '@kit.UniversalKeystoreKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const ALIAS_DEVICE = 'shibei_spike_device_v1';
const ALIAS_BIO = 'shibei_spike_bio_v1';
const TAG = 'shibei-huks-spike';

export async function runSpike(): Promise<string> {
  const lines: string[] = [];
  const log = (s: string): void => { lines.push(s); hilog.info(0x0000, TAG, s); };

  // 1) Device-bound AES-256-GCM key
  try {
    const props: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
    ];
    await huks.generateKeyItem(ALIAS_DEVICE, { properties: props });
    log('device key generated OK');
  } catch (e) {
    log(`device key FAIL: ${(e as Error).message}`);
  }

  // 2) Bio-gated key — verify INVALID_NEW_BIO_ENROLL property is settable
  try {
    const bioProps: huks.HuksParam[] = [
      { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
      { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
      { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
      { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
      { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
      { tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE, value: huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE },
      { tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE, value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_NEW_BIO_ENROLL },
      { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL },
    ];
    await huks.generateKeyItem(ALIAS_BIO, { properties: bioProps });
    log('bio key generated OK');
  } catch (e) {
    log(`bio key FAIL (may be OK if no biometric enrolled): ${(e as Error).message}`);
  }

  // 3) Cleanup
  try { await huks.deleteKeyItem(ALIAS_DEVICE, { properties: [] }); } catch (e) {}
  try { await huks.deleteKeyItem(ALIAS_BIO, { properties: [] }); } catch (e) {}

  return lines.join('\n');
}

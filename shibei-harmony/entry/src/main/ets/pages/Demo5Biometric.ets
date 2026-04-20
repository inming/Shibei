import { huks } from '@kit.UniversalKeystoreKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const ALIAS: string = 'shibei_demo5_key';

@Entry
@Component
struct Demo5Biometric {
  @State log: Array<string> = [];

  private appendLog(s: string): void {
    this.log = [`${new Date().toISOString().substring(11, 23)} ${s}`, ...this.log].slice(0, 40);
    hilog.info(0x0000, 'shibei', 'demo5 %{public}s', s);
  }

  private async generateKey(): Promise<void> {
    try {
      const options: huks.HuksOptions = {
        properties: [
          { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
          { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
          {
            tag: huks.HuksTag.HUKS_TAG_PURPOSE,
            value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT
          },
          { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_NONE },
          { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_GCM },
          {
            tag: huks.HuksTag.HUKS_TAG_USER_AUTH_TYPE,
            value: huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FINGERPRINT | huks.HuksUserAuthType.HUKS_USER_AUTH_TYPE_FACE
          },
          {
            tag: huks.HuksTag.HUKS_TAG_KEY_AUTH_ACCESS_TYPE,
            value: huks.HuksAuthAccessType.HUKS_AUTH_ACCESS_INVALID_CLEAR_PASSWORD
          },
          { tag: huks.HuksTag.HUKS_TAG_CHALLENGE_TYPE, value: huks.HuksChallengeType.HUKS_CHALLENGE_TYPE_NORMAL }
        ]
      };
      await huks.generateKeyItem(ALIAS, options);
      this.appendLog('key generated');
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.appendLog(`generate error: ${msg}`);
    }
  }

  private async authAndUse(): Promise<void> {
    try {
      const t0: number = Date.now();
      const authParam: userAuth.AuthParam = {
        challenge: new Uint8Array(32),
        authType: [userAuth.UserAuthType.FACE, userAuth.UserAuthType.FINGERPRINT],
        authTrustLevel: userAuth.AuthTrustLevel.ATL3
      };
      const widgetParam: userAuth.WidgetParam = { title: '解锁 Demo 5 密钥' };
      const auth: userAuth.UserAuthInstance = userAuth.getUserAuthInstance(authParam, widgetParam);
      // HarmonyOS 6.1 API: auth.on('result', ...) expects an IAuthCallback
      // object with an onResult(UserAuthResult) method, not a bare function.
      // UserAuthResult replaces the deprecated AuthResultInfo.
      await new Promise<void>((resolve, reject) => {
        const cb: userAuth.IAuthCallback = {
          onResult: (r: userAuth.UserAuthResult) => {
            this.appendLog(`auth result: code=${r.result} token=${r.token ? 'yes' : 'no'}`);
            if (r.result === userAuth.UserAuthResultCode.SUCCESS) {
              resolve();
            } else {
              reject(new Error(`auth failed code=${r.result}`));
            }
          }
        };
        auth.on('result', cb);
        auth.start();
      });
      const t1: number = Date.now();
      this.appendLog(`auth ok in ${t1 - t0}ms`);
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.appendLog(`auth error: ${msg}`);
    }
  }

  private async deleteKey(): Promise<void> {
    try {
      await huks.deleteKeyItem(ALIAS, { properties: [] });
      this.appendLog('key deleted');
    } catch (err) {
      const msg: string = `${err.name}: ${err.message}`;
      this.appendLog(`delete error: ${msg}`);
    }
  }

  build() {
    Column() {
      Text('Demo 5: HUKS biometric key').fontSize(18).margin({ top: 16 });
      Button('1. generate biometric-bound key').margin({ top: 8 })
        .onClick(() => { this.generateKey(); });
      Button('2. authenticate (biometric prompt)').margin({ top: 8 })
        .onClick(() => { this.authAndUse(); });
      Button('3. delete key').margin({ top: 8 })
        .onClick(() => { this.deleteKey(); });
      Scroll() {
        Column() {
          ForEach(this.log, (e: string) => {
            Text(e).fontSize(11).fontFamily('monospace');
          }, (e: string) => e);
        }
      }.height('60%').margin({ top: 16 });
    }
    .width('100%').height('100%').padding(16);
  }
}

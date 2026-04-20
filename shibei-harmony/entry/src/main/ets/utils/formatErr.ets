// ArkTS strict mode bans `any` and `unknown`. In practice the values
// reaching this helper are always Error subclasses (BusinessError etc).
export function formatErr(err: Error): string {
  return `${err.name}: ${err.message}`;
}

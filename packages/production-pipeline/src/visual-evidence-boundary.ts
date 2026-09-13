const GENERATED_EVIDENCE_CLAIMS = [
  /(?:已(?:经)?|得到|完成|成功)(?:被)?(?:验证|证实|证明)/g,
  /(?:验证|证实|证明)(?:了|通过|成立|有效|因果|效果|结果)/g,
  /(?:真实|现实|实拍|现场)(?:验证|实验|测试|结果|证据|效果)/g,
  /(?:因果|产品效果|方法效果).{0,8}(?:成立|已验证|得到验证|被证明)/g,
] as const;

const NEGATED_CLAIM_PREFIX = /(?:不|非|不能|不得|并非|不是|不可|未)(?:能|得|是|可)?[^，。；！？!?]{0,12}$/;

const CROSS_SCENE_IDENTITY = [
  /同一(?:人物|角色|人|主体|物件|物体|对象|杯子|产品|实验对象)/,
  /(?:上一镜|前一镜|前镜|前后镜|跨镜|镜头间).{0,18}(?:人物|角色|主体|物件|物体|对象|杯子|产品).{0,12}(?:一致|不变|相同|延续)/,
  /(?:人物|角色|主体|物件|物体|对象|杯子|产品).{0,12}(?:保持|必须|需要|继续).{0,12}(?:一致|不变|相同)/,
] as const;

const NEGATED_IDENTITY_SCOPE = /(?:不|非|无|未|别|免)[^，。；！？!?]{0,8}$/;

export function assertGeneratedVisualDoesNotClaimEvidence(
  values: Array<string | undefined>,
  label: string,
): void {
  for (const value of values) {
    if (!value) continue;
    for (const pattern of GENERATED_EVIDENCE_CLAIMS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(value);
      while (match) {
        const prefix = value.slice(Math.max(0, match.index - 18), match.index);
        if (!NEGATED_CLAIM_PREFIX.test(prefix)) {
          throw new Error(`${label} treats a generated visual as real-world evidence: ${match[0]}`);
        }
        match = pattern.exec(value);
      }
    }
  }
}

export function requiresUnsupportedGeneratedIdentity(values: Array<string | undefined>): boolean {
  return values.some((value) => value?.split(/[，。；！？!?\n]/).some((clause) => (
    CROSS_SCENE_IDENTITY.some((pattern) => {
      const match = pattern.exec(clause);
      if (!match) return false;
      return !NEGATED_IDENTITY_SCOPE.test(clause.slice(0, match.index));
    })
  )));
}

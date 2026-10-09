const CROSS_SCENE_IDENTITY = [
  /同一(?:人物|角色|人|主体|物件|物体|对象|杯子|产品|实验对象)/,
  /(?:上一镜|前一镜|前镜|前后镜|跨镜|镜头间).{0,18}(?:人物|角色|主体|物件|物体|对象|杯子|产品).{0,12}(?:一致|不变|相同|延续)/,
  /(?:人物|角色|主体|物件|物体|对象|杯子|产品).{0,12}(?:保持|必须|需要|继续).{0,12}(?:一致|不变|相同)/,
] as const;

const NEGATED_IDENTITY_SCOPE = /(?:不|非|无|未|别|免)[^，。；！？!?]{0,8}$/;

export function requiresUnsupportedGeneratedIdentity(values: Array<string | undefined>): boolean {
  return values.some((value) => value?.split(/[，。；！？!?\n]/).some((clause) => (
    CROSS_SCENE_IDENTITY.some((pattern) => {
      const match = pattern.exec(clause);
      if (!match) return false;
      return !NEGATED_IDENTITY_SCOPE.test(clause.slice(0, match.index));
    })
  )));
}

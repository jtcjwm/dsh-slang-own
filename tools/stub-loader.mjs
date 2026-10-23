/** 把 @deepseek-ai/dsh-tools 重定向到本地桩，便于脱离宿主做装配测试。 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stub-dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}

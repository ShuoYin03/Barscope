'use strict'
// Basic content gate for review text — minimum length plus a hardcoded list of common Chinese/
// English profanity and slurs. This is a first-pass substring filter (normalized against spacing/
// punctuation to catch simple evasion like "傻 * 逼"), not a comprehensive moderation system —
// determined users can still get around it. Extend BAD_WORDS as new cases show up.
const MIN_LENGTH = 10

const BAD_WORDS = [
  '傻逼', '傻屄', '煞笔', '沙比', '傻比', 'sb', '智障', '脑残', '弱智', '废物', '人渣', '畜生', '杂种',
  '婊子', '妓女', '贱人', '贱货', '狗娘养的', '死全家', '去死吧', '滚你妈',
  '妈的', '他妈的', 'tmd', 'cnm', 'nmsl', '操你妈', '日你妈', '草你妈', '我操', '我艹',
  'fuck', 'fucker', 'fucking', 'bitch', 'asshole', 'cunt', 'nigger', 'retard',
]

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\s.,!?~*_\-·、。！？，]/g, '')
}

const NORMALIZED_BAD_WORDS = BAD_WORDS.map(normalize)

function findBadWord(text) {
  const normalized = normalize(text)
  const hit = NORMALIZED_BAD_WORDS.find(w => w && normalized.includes(w))
  return hit || null
}

// Returns { ok:true } or { ok:false, error:string }.
function moderateContent(rawContent) {
  const content = String(rawContent || '').trim()
  if (content.length < MIN_LENGTH) return { ok:false, error:`评论内容至少需要 ${MIN_LENGTH} 个字` }
  if (findBadWord(content)) return { ok:false, error:'评论包含不当用语，请修改后重新提交' }
  return { ok:true, content }
}

module.exports = { moderateContent, MIN_LENGTH }

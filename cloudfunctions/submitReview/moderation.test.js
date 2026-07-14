'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { moderateContent } = require('./moderation')

test('rejects content shorter than the minimum length', () => {
  const r = moderateContent('太短了')
  assert.equal(r.ok, false)
  assert.match(r.error, /10/)
})

test('accepts content at or above the minimum length', () => {
  const r = moderateContent('这是一条正常的十个字以上的评论内容')
  assert.equal(r.ok, true)
})

test('rejects content containing a profanity match', () => {
  const r = moderateContent('这张专辑真的是傻逼制作人做的东西')
  assert.equal(r.ok, false)
  assert.match(r.error, /不当用语/)
})

test('catches profanity spaced out to evade a naive substring match', () => {
  const r = moderateContent('这张专辑真的是傻 * 逼制作出来的东西')
  assert.equal(r.ok, false)
})

test('trims content before checking length and before returning it', () => {
  const r = moderateContent('   这是一条正常的十个字以上的评论内容   ')
  assert.equal(r.ok, true)
  assert.equal(r.content, '这是一条正常的十个字以上的评论内容')
})

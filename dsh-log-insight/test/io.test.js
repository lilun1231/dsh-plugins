import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, decodeHtml, extractInputValue } from '../lib/io.js';

test('Cookie 容器能按响应头收集并序列化', () => {
  const jar = new CookieJar();
  jar.collect(['a=1; Path=/', 'b=2; HttpOnly']);
  assert.equal(jar.header(), 'a=1; b=2');
});

test('同名 Cookie 后写入的覆盖先写入的', () => {
  const jar = new CookieJar();
  jar.collect(['sid=old']);
  jar.collect(['sid=new']);
  assert.equal(jar.header(), 'sid=new');
});

test('HTML 实体解码：加号与与号', () => {
  assert.equal(decodeHtml('&lt;a&gt;&amp;b&#43;c'), '<a>&b+c');
  assert.equal(decodeHtml('state=abc&#43;def&amp;x=1'), 'state=abc+def&x=1');
});

test('从 HTML 中提取 input 的 value', () => {
  const html = '<input type="hidden" name="then" value="https://a/b?c=1&#43;2&amp;d=3">';
  assert.equal(extractInputValue(html, 'then'), 'https://a/b?c=1+2&d=3');
});

test('提取不存在的 input 返回 null', () => {
  assert.equal(extractInputValue('<div>x</div>', 'nope'), null);
});

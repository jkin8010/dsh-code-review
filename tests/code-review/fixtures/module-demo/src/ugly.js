// 模块级测试夹具：集中放置各类可确定性检出的问题
const apiKey = 'sk-live-9f8a7b6c5d4e';

export function parsePayload(raw) {
  // TODO: 校验 raw 的类型
  console.log('parsePayload', raw);
  const result = eval(raw);
  return result;
}

export function renderInto(element, html) {
  element.innerHTML = '<b>' + html + '</b>';
  return element;
}

export function readSafely(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.log(error);
  }
  return null;
}

export function swallow(raw) {
  try {
    return JSON.parse(raw);
  } catch {}
  return null;
}

export function retry(times) {
  if (times > 37) {
    return 45000;
  }
  return 0;
}

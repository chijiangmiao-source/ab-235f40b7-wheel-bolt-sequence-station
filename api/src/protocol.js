'use strict';

// 协议常量：六颗螺栓的固定复核顺序（每个新会话不可更改）。
// 位置码：A/B 为工位侧，1/2/3 为螺栓编号。
const BOLT_ORDER = Object.freeze([
  { seq: 1, position: 'A1' },
  { seq: 2, position: 'B2' },
  { seq: 3, position: 'A3' },
  { seq: 4, position: 'B1' },
  { seq: 5, position: 'A2' },
  { seq: 6, position: 'B3' },
]);

const TOTAL = BOLT_ORDER.length;
const TORQUE_MIN = 4200; // 合格下限（含边界），单位 cN·m
const TORQUE_MAX = 4800; // 合格上限（含边界），单位 cN·m
const TORQUE_UNIT = 'cN·m';

function expectedPosition(seq) {
  return Number.isInteger(seq) && seq >= 1 && seq <= TOTAL
    ? BOLT_ORDER[seq - 1].position
    : null;
}

module.exports = { BOLT_ORDER, TOTAL, TORQUE_MIN, TORQUE_MAX, TORQUE_UNIT, expectedPosition };

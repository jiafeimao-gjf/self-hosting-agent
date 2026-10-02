// 测试夹具：往 stderr 狂喷的「Agent」，用来验证 stderr 缓冲有上限（DIAG-004）。
const line = `[noisy] ${'x'.repeat(200)}\n`;
for (let i = 0; i < 400; i += 1) process.stderr.write(line);
// 末尾留一条标记：不立刻 exit，否则管道里没 flush 完的 stderr 会丢
process.stderr.write('[noisy] 最后一行\n');
setTimeout(() => process.exit(0), 150);

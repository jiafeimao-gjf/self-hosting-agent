// 测试夹具：一个长期存活的「Agent」，用来验证 kill 语义（KERN-006）。
process.stdin.resume();
setInterval(() => {
  /* 保持进程存活 */
}, 1000);

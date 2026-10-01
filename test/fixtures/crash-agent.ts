// 测试夹具：一个会崩溃的「Agent」，用来验证崩溃隔离（KERN-007）。
process.stderr.write('fixture: 即将崩溃\n');
process.exit(3);

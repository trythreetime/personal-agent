import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const allowed = {
  'apps/web': ['contracts'],
  'apps/server': ['contracts', 'core', 'agent-runtime', 'infrastructure'],
  'packages/contracts': [],
  'packages/core': ['contracts'],
  'packages/agent-runtime': ['contracts', 'core'],
  'packages/infrastructure': ['contracts', 'core'],
};
const failures = [];
async function scan(root, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(root, path);
    else if (/\.(ts|vue)$/.test(entry.name)) {
      const source = await readFile(path, 'utf8');
      const imports = [
        ...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      for (const name of imports) {
        const internal = name.match(/^@digital-worker\/([^/]+)(.*)$/);
        if (internal && (!allowed[root].includes(internal[1]) || internal[2]))
          failures.push(`${relative('.', path)} 不允许导入 ${name}`);
        if (/^@openai\/agents/.test(name) && root !== 'packages/agent-runtime')
          failures.push(`${relative('.', path)} 不能直接依赖 SDK`);
        if (
          root === 'packages/core' &&
          /^(fastify|drizzle-orm|better-sqlite3|node:fs|node:path|openai)/.test(name)
        )
          failures.push(`${relative('.', path)} 不能依赖具体基础设施`);
        if (
          root === 'apps/web' &&
          relative(resolve(root), path).replaceAll('\\', '/').startsWith('src/') &&
          /^node:/.test(name)
        )
          failures.push(`${relative('.', path)} 不能导入 Node.js 模块`);
      }
    }
  }
}
for (const root of Object.keys(allowed)) await scan(root, resolve(root));
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('模块依赖边界检查通过。\n');

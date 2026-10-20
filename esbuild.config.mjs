import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	outfile: 'main.js',
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	target: 'es2020',
	external: ['obsidian', 'electron', ...builtinModules],
	minify: production,
	sourcemap: production ? false : 'inline',
	treeShaking: true,
	logLevel: 'info',
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}

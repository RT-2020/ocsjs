import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import banner from 'vite-plugin-banner';
import { author, description, homepage, license, name } from '../../package.json';
import dotenv from 'dotenv';
import path from 'path';

const bannerContent = `
/*!
 * ${name} ( ${homepage} )
 * ${description}
 * copyright ${author}
 * license ${license}
 */
`;

// 从项目根目录读取 .env（vite 在 packages/scripts 下运行，dotenv 默认只读 cwd 的 .env，读不到根目录的）
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// https://vitejs.dev/config/
export default defineConfig({
	resolve: {
		alias: {
			'@ocsjs/core': '../core/src/index.ts'
		}
	},
	esbuild: {
		charset: 'utf8'
	},
	build: {
		/** 取消css代码分离 */
		cssCodeSplit: false,
		/** @ts-ignore 输出路径 */
		outDir: process.env.VITE_BUILD_PATH,
		/** 清空输出路径 */
		emptyOutDir: false,
		/** 是否压缩代码 */
		minify: false,

		/** 打包库， 全局名字为 OCS */
		lib: {
			entry: './src/index.ts',
			name: 'OCS',
			fileName: () => 'index.js',
			formats: ['umd']
		}
	},

	plugins: [
		// commonjs(),
		visualizer(),
		banner(bannerContent)
	]
});

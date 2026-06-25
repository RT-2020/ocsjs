/**
 * 慕享 (moycp.com) 跨脚本共享工具与状态。
 *
 * 从 moycp.ts 拆分而来（纯搬运，零逻辑变更）。
 * moycp.ts（主文件，含各 Script 定义）和 moycp-work.ts（答题工作器）共同依赖这些工具，
 * 集中在此避免重复定义与循环依赖。
 */
import { $ } from '@ocsjs/core';
import { $message, $store } from 'easy-us';
import { $console } from './background';

export const $msg_and_log = (type: 'info' | 'warn' | 'error', msg: string) => {
	$message[type](msg);
	$console[type](msg);
};

/**
 * moycp 诊断日志：统一走 OCS 后台「📄 日志输出」面板（$console）。
 *
 * 为什么不用浏览器 console：慕享页面会不断清空/覆盖 window.console，F12 看不到脚本日志。
 * 为什么不另起浮层：OCS 已有原生日志面板，直接复用，避免引入额外 UI。
 * 与 cx/icve 等课程一致，直接调用 $console.log（无需 try/catch，框架内部已处理）。
 */
export const $dbg = (msg: string) => $console.log('[moycp] ' + msg);

/**
 * 模拟人工操作的随机延迟，降低被慕享反作弊检测的风险。
 *
 * @param minMs 最小延迟（毫秒）
 * @param maxMs 最大延迟（毫秒）
 * @returns Promise，在 [minMs, maxMs] 区间内的随机时间后 resolve
 */
export const humanSleep = (minMs = 150, maxMs = 350) =>
	$.sleep(minMs + Math.floor(Math.random() * (maxMs - minMs + 1)));

/** 慕享全局运行时状态（跨脚本共享） */
export const state = {
	currentMedia: undefined as HTMLMediaElement | undefined,
	currentUrl: '',
	currentRunningScriptName: '',
	current_job_id: '',
	// work.main 防重入锁：多条触发路径（oncomplete/dispatcher/study 主动）互斥
	workRunning: false,
	// study Phase1（视频优先）连续播放循环防重入锁：
	// videoFirst 模式下 study 在视频页点 sidebar 连续播放，每次重入 study.main 处理一个子视频，
	// 此锁防止 dispatcher 与 study 自身导航重入并发触发。
	videoFirstJobRunning: false,
	// videoFirst Phase1 防死循环：记录本轮点过且状态未变的 sidebar 子视频标题 → 次数。
	// key=子视频 title，value=连续无响应次数。≥3 则跳过该视频（Vue 拦截/无响应兜底）。
	// 会话级（模块重载重置，合理——重载后 sidebar 真实状态已变）。
	videoFirstTried: {} as Record<string, number>,
	// 闯关失败自动重闯计数（按 itemId 区分会话内同一小节的重闯次数）
	examRetryCount: {} as Record<string, number>
};

/** 获取当前页面的路由标识（pathname，用于匹配 runAtUrl） */
export const getCurrentPath = () => location.pathname;

/** 判断当前 URL 是否包含任一关键词（用于脚本匹配） */
export const urlMatches = (keywords: string[]) => {
	const full = location.pathname + location.search;
	return keywords.some((k) => full.includes(k));
};

const VIDEO_DONE_KEY = 'moycp_video_done';

/**
 * 视频完成缓存（按「课程ID + 章节标题」持久化）。
 *
 * 背景（MCP 实测确认，2026-06）：
 *   课程目录页的进度条（.alreadyStudyProgress，如"40%"）是章节聚合进度，会延迟/不准；
 *   视频页右上角的进度（span.alreadystudy，如"已学习100%"）才准确。
 *   用户场景："视频看完了但目录进度没到100%"——单个子视频看完≠整个章节聚合进度满。
 *
 * 本缓存记录"某课程某章节的视频，已在视频页右上角确认 100% 完成"。
 * 用 $store 持久化（目录↔视频↔答题循环含整页 reload，内存 state 会重置）。
 *
 * 结构：{ [courseId]: { [章节标题]: true } }
 * key 用「课程ID + 章节标题」（目录页 DOM 无 itemId/chapterId，只能用标题关联）。
 * 若慕享改章节名缓存会失效，但有 study 脚本二次验证兜底（失效后重新验证一次即重建）。
 */
export const videoDoneCache = {
	_read(): Record<string, Record<string, boolean>> {
		return $store.get(VIDEO_DONE_KEY, {}) || {};
	},
	_writeAll(data: Record<string, Record<string, boolean>>): void {
		$store.set(VIDEO_DONE_KEY, data);
	},
	has(courseId: string, sectionTitle: string): boolean {
		if (!courseId || !sectionTitle) return false;
		return !!this._read()[courseId]?.[sectionTitle];
	},
	set(courseId: string, sectionTitle: string): void {
		if (!courseId || !sectionTitle) return;
		const data = this._read();
		if (!data[courseId]) data[courseId] = {};
		data[courseId][sectionTitle] = true;
		this._writeAll(data);
	}
};

import debounce from 'lodash/debounce';
import {
	defaultAnswerWrapperHandler,
	AnswerWrapperParser,
	request,
	SimplifyWorkResult,
	$,
	WorkUploadType,
	AnswerWrapperHandlerConfig
} from '@ocsjs/core';
import { $message, h, $gm, $store, Project, Script, $modal, StoreListenerType, $ui } from 'easy-us';
import type { AnswererWrapper, SearchInformation } from '@ocsjs/core';
import { CXProject, ICourseProject, IcveMoocProject, YKTProject, ZHSProject, ZJYProject } from '../index';
import { markdown } from '../utils/markdown';
import { enableCopy } from '../utils';
import { SearchInfosElement } from '../elements/search.infos';
import { RenderScript } from '../render';
import { dropdownStyle } from '../utils/configs';

const TAB_WORK_RESULTS_KEY = 'common.work-results.results';

const state = {
	workResult: {
		/**
		 * 题目位置同步处理器
		 */
		questionPositionSyncHandler: {
			cx: (index: number) => {
				const el = document.querySelectorAll<HTMLElement>('[id*="sigleQuestionDiv"], .questionLi')?.item(index);
				if (el) {
					window.scrollTo({
						top: el.getBoundingClientRect().top + window.pageYOffset - 50,
						behavior: 'smooth'
					});
				}
			},
			'zhs-gxk': (index: number) => {
				document.querySelectorAll<HTMLElement>('.answerCard_list ul li').item(index)?.click();
			},
			'zhs-xnk': (index: number) => {
				document.querySelectorAll<HTMLElement>('.jobclassallnumber-div li[questionid]').item(index)?.click();
			},
			'zhs-smart': (index: number) => {
				document.querySelectorAll<HTMLElement>('[role="treeitem"] .font-sec-style-node').item(index)?.click();
			},
			'zhs-fusion': (index: number) => {
				document.querySelectorAll<HTMLElement>('.right-box .list .item').item(index)?.click();
			},
			'zhs-hike': (index: number) => {
				document.querySelectorAll<HTMLElement>('.q_main_right .card_ul .card_li').item(index)?.click();
			},
			icve: (index: number) => {
				document.querySelectorAll<HTMLElement>(`.sheet_nums [id*="sheetSeq"]`).item(index)?.click();
			},
			zjy: (index: number) => {
				document
					.querySelectorAll<HTMLElement>('.subjectDet')
					.item(index)
					?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			},
			icourse: (index: number) => {
				document
					.querySelectorAll<HTMLElement>('.u-questionItem,[class*=questionBody]')
					.item(index)
					?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			},
			moycp: (index: number) => {
				// 慕享为单题逐题模式，点击答题卡对应题号切换到该题
				// 答题卡 .select-item-list 下的 span 为 Vue 元素，需补充 MouseEvent 触发
				const clickVue = (el: HTMLElement) => {
					el.click();
					el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				};
				const nav = document
					.querySelectorAll<HTMLElement>('.select-item-list span')
					.item(index);
				if (nav) {
					clickVue(nav);
				} else {
					// 兜底：逐题切换到目标题
					const current = document.querySelector<HTMLElement>('.select-item-list span.current');
					let currentIdx = current ? Array.from(current.parentElement!.children).indexOf(current) : 0;
					const next = () => document.querySelector<HTMLElement>('.btn.next');
					const interval = setInterval(() => {
						if (currentIdx >= index) {
							clearInterval(interval);
							return;
						}
						const n = next();
						if (n) {
							clickVue(n);
							currentIdx++;
						}
					}, 500);
				}
			}
		}
	},
	setting: {
		listenerIds: {
			aw: 0 as StoreListenerType
		}
	}
};

/**
 * 题库缓存类型
 *
 * type（题型）为可选维度：
 * - 同一题干在不同题型下答案可能不同（如"判断题版"与"单选题版"），按 type 区分避免冲突。
 * - 向后兼容：旧缓存无 type，匹配/去重时 type 为 undefined 时退化为仅按 title 处理，
 *   未传 type 的课程（cx/icourse/icve/zhs/...）行为不变。
 */
type QuestionCache = { title: string; answer: string; from: string; homepage: string; ai?: boolean; type?: string };

export const CommonProject = Project.create({
	name: '通用',
	domains: [],
	scripts: {
		guide: new Script({
			name: '🏠 使用教程',
			matches: [['所有页面', /.*/]],
			namespace: 'common.guide',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'打开任意网课平台，进入视频、作业页面等待脚本运行，',
						'⚠️ 禁止与其他脚本一起使用（不兼容），也不能开多个相同脚本',
						'⚠️ 禁止最小化浏览器、切屏，否则可能导致脚本无法运行！',
						'有疑问请访问下方交流群，进群后带截图进行反馈。'
					]).outerHTML
				}
			},
			onrender({ panel }) {
				const guide = createGuide();
				panel.body.replaceChildren(guide);
			}
		}),
		settings: new Script({
			name: '⚙️ 全局设置',
			matches: [['所有页面', /.*/]],
			namespace: 'common.settings',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'✨鼠标移动到按钮或者输入框，可以看到提示！',
						'想要自动答题必须设置 “题库配置” ',
						'设置后进入章节测试，作业，考试页面即可自动答题。'
					]).outerHTML
				},
				answererWrappers: {
					separator: '自动答题设置',
					defaultValue: [] as AnswererWrapper[]
				},
				/**
				 * 禁用的题库
				 */
				disabledAnswererWrapperNames: {
					defaultValue: [] as string[]
				},
				answererWrappersButton: {
					label: '题库配置',
					defaultValue: '点击配置',
					attrs: {
						type: 'button'
					},
					onload() {
						const aws: any[] = CommonProject.scripts.settings.cfg.answererWrappers || [];
						this.value = aws.length ? aws.length + ' 个可用题库（点击进入配置）' : '点击进入配置';

						this.onclick = () => {
							const aw: any[] = CommonProject.scripts.settings.cfg.answererWrappers || [];
							const copy = $ui.copy('复制题库配置', JSON.stringify(aw, null, 4));

							const list = h('div', [
								h('div', { style: { marginTop: '8px' } }, aw.length ? ['以下是已经解析过的题库配置：', copy] : ''),
								...createAnswererWrapperList(aw)
							]);
							const textarea = h(
								'textarea',
								{
									className: 'modal-input',
									style: { minHeight: '250px', width: 'calc(100% - 20px)', maxWidth: '100%' },
									placeholder: aw.length ? '重新输入题库配置' : '输入你的题库配置...，不会请看上方填写教程'
								},
								aw.length === 0 ? '' : JSON.stringify(aw, null, 4)
							);

							const select = $ui.tooltip(
								h(
									'select',
									{
										className: 'base-style-active-form-control',
										style: { backgroundColor: '#eef2f7', borderRadius: '2px', padding: '2px 8px' }
									},
										[
											h('option', '默认'),
											h(
												'option',
												{
													title:
														'大学生网课题库接口适配器: 将不同的题库整合为一个API接口。详细查看 https://github.com/DokiDoki1103/tikuAdapter'
												},
												'TikuAdapter'
											),
											h(
												'option',
												{
													title:
														'接入 OpenAI 兼容协议的大模型题库（GPT/DeepSeek/Kimi/通义等中转站），只需填写 API 地址 + Key + 模型名'
												},
												'AI大模型'
											)
										]
									)
							);

							const modal = $modal.prompt({
								width: 600,
								maskCloseable: false,
								content: $ui.notes([
									[
										h('div', { style: { fontSize: '16px', marginBottom: '8px' } }, [
											h('b', '题库配置填写教程👉：'),
											h('a', { href: 'https://docs.ocsjs.com/docs/work' }, 'https://docs.ocsjs.com/docs/work')
										])
									],
									[
										h(
											'div',
											{
												className: 'secondary'
											},
											[
												'⚠️ 如果无法粘贴，请点->：',
												h('button', '读取剪贴板', (btn) => {
													btn.classList.add('base-style-button');
													btn.onclick = () => {
														navigator.clipboard.readText().then((result) => {
															textarea.value = result;
														});
													};
												}),
												'，并同意浏览器上方的剪贴板读取申请。'
											]
										)
									],
									[
										h(
											'div',
											{ className: 'secondary' },
											'⚠️ 如果想添加多个不同的题库配置，请在每个配置之间使用三个井号隔开: ###。'
										)
									],
									[h('div', { className: 'secondary' }, '⚠️ 配置第三方题库出现网页弹窗的，点击永久允许连接。')],
									...(aw.length ? [list] : [])
								]),
								footer: h('div', { style: { width: '100%' } }, [
									h('div', { className: 'separator secondary' }, '题库配置填写/修改区'),
									textarea,
									h('div', { style: { display: 'flex', flexWrap: 'wrap', marginTop: '12px', fontSize: '12px' } }, [
										h('div', ['解析器：', select], (div) => {
											div.style.marginRight = '12px';
											div.style.flex = '1';
										}),
										h('div', { style: { flex: '1', display: 'flex', flexWrap: 'wrap', justifyContent: 'end' } }, [
											h('button', '清空题库配置', (btn) => {
												btn.className = 'modal-cancel-button';
												btn.style.marginRight = '48px';
												btn.onclick = () => {
													$modal.confirm({
														content: '确定要清空题库配置吗？',
														onConfirm: () => {
															$message.success({ content: '已清空，在答题前请记得重新配置。' });
															modal?.remove();
															CommonProject.scripts.settings.cfg.answererWrappers = [];
															this.value = '点击配置';
														}
													});
												};
											}),
											h('button', '关闭', (btn) => {
												btn.className = 'modal-cancel-button';
												btn.style.marginRight = '12px';
												btn.onclick = () => modal?.remove();
											}),
											h('button', '保存配置', (btn) => {
												btn.className = 'modal-confirm-button';
												btn.onclick = async () => {
													const connects: string[] = $gm.getMetadataFromScriptHead('connect');

													const value = textarea.value;

													// AI大模型解析器使用专用配置面板，不依赖 textarea 内容
													if (!value && select.value !== 'AI大模型') {
														$modal.alert({
															content: h('div', '不能为空！')
														});
														return;
													}
													if (value.includes('adapter-service/search') && (select.value === 'TikuAdapter') === false) {
														$modal.alert({
															content: h('div', [
																'检测到您可能正在使用 ',
																h(
																	'a',
																	{ href: 'https://github.com/DokiDoki1103/tikuAdapter#readme' },
																	'TikuAdapter 题库'
																),
																'，但是您选择的解析器不是 TikuAdapter，请选择 TikuAdapter 解析器，并填写接口地址即可，例如：http://localhost:8060/adapter-service/search，或者忽略此警告。'
															]),
															confirmButtonText: '切换至 TikuAdapter 解析器，并识别接口地址',
															onConfirm() {
																const origin =
																	textarea.value.match(/http:\/\/(.+)\/adapter-service\/search/)?.[1] || '';
																textarea.value = `http://${origin}/adapter-service/search`;
																select.value = 'TikuAdapter';
															}
														});
														return;
													}

													try {
														let awsResult: AnswererWrapper[] = [];
														if (select.value === 'TikuAdapter') {
															if (value.startsWith('http') === false) {
																$modal.alert({
																	content: h('div', [
																		'格式错误，TikuAdapter解析器只能解析 url 链接，请重新输入！或者查看：',
																		h(
																			'a',
																			{ href: 'https://github.com/DokiDoki1103/tikuAdapter#readme' },
																			'https://github.com/DokiDoki1103/tikuAdapter#readme'
																		)
																	])
																});
																return;
															}
															select.value = '默认';
															awsResult.push({
																name: 'TikuAdapter题库',
																url: value,
																homepage: 'https://github.com/DokiDoki1103/tikuAdapter',
																method: 'post',
																type: 'GM_xmlhttpRequest',
																contentType: 'json',
																headers: {},
																data: {
																	// eslint-disable-next-line no-template-curly-in-string
																	question: '${title}',
																	options: {
																		handler: "return (env)=>env.options?.split('\\n')"
																	},
																	type: {
																		handler:
																			" return (env)=> env.type === 'single' ? 0 : env.type === 'multiple' ? 1 : env.type === 'completion' ? 3 : env.type === 'judgement' ? 4 : undefined"
																	}
																},
																handler: "return (res)=>res.answer.allAnswer.map(i=>([res.question,i.join('#')]))"
															});
										} else if (select.value === 'AI大模型') {
											// AI 大模型题库：弹出专用配置面板（带测试连接按钮）
											// ⚠️ 支持多组 AI 配置（主+备用）：每次选择都追加一个新的 AI wrapper，
											// 不再替换已有的 AI。多个 AI 会按数组顺序被 moycp answerer
											// 顺序 fallback（第一个失败才试下一个）。
											// ⚠️ awsResult 从空数组开始，必须先带入已有的所有 wrapper（aw），
											// 否则添加 AI 会清空已配置的其他题库。
											const existingAIs = aw.filter((x) => x.name === 'AI大模型题库');
											// 保留已有配置（避免添加 AI 时丢失其他题库/已有 AI）
											awsResult.push(...aw);
											const lastAI = existingAIs[existingAIs.length - 1];
											let initUrl = '';
											let initKey = '';
											let initModel = 'gpt-3.5-turbo';
											if (lastAI) {
												initUrl = lastAI.url || '';
												initKey = (lastAI.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
												initModel = (lastAI.data as any)?.model || (lastAI.data as any)?._aiModel || 'gpt-3.5-turbo';
											}

											const formData = await showAIConfigPanel(initUrl, initKey, initModel);

											if (!formData || !formData.url || !formData.key) {
												return;
											}

											select.value = '默认';
											// 自动补全地址路径：只填到 /v1 的也自动补全
											let apiUrl = formData.url.replace(/\/$/, '');
											if (!apiUrl.includes('/chat/completions')) {
												if (apiUrl.includes('/v1')) {
													apiUrl = apiUrl + '/chat/completions';
												} else {
													apiUrl = apiUrl + '/v1/chat/completions';
												}
											}
											awsResult.push(
												createAIAnswererWrapper({
													url: apiUrl,
													key: formData.key,
													model: formData.model || 'gpt-3.5-turbo'
												})
											);
											// 提示用户当前 AI 数量
											$message.success({
												content: `AI 题库已配置 ${existingAIs.length + 1} 个。答题时按顺序尝试，第一个不可用自动切换下一个。`,
												duration: 8
											});
															} else {
																const contents = value
																	.split('###')
																	.map((i) => i.trim())
																	.filter(Boolean);
																for (const content of contents) {
																	awsResult.push(...(await AnswerWrapperParser.from(content)));
																}
															}


														// 为空判断
														if (awsResult.length === 0) {
															$modal.alert({ content: '题库配置不能为空，请重新配置。' });
															return;
														}

														// 唯一化处理
														const result_set: AnswererWrapper[] = [];
														for (const res of awsResult) {
															if (result_set.find((i) => JSON.stringify(i) === JSON.stringify(res))) {
																continue;
															}
															result_set.push(res);
														}
														awsResult = result_set;

														// 判断新旧是否一致，如果一致则提示
														if (
															JSON.stringify(CommonProject.scripts.settings.cfg.answererWrappers) ===
															JSON.stringify(awsResult)
														) {
															$modal.alert({ content: h('div', ['题库配置没有变化，请重新配置！']) });
															return;
														}

														// 判断题库是否超过限制（10个），如果超过则提示
														if (awsResult.length > 10) {
															$modal.alert({
																content: h('div', [
																	'题库配置过多可能会导致答题效率降低，建议不超过10个题库，目前解析到' +
																		awsResult.length +
																		'个题库，请删除一些不必要的题库后重新配置！'
																])
															});
															return;
														}

														CommonProject.scripts.settings.cfg.answererWrappers = awsResult;
														this.value = '当前有' + awsResult.length + '个可用题库';
														$modal.confirm({
															width: 600,
															content: h('div', [
																h('div', [
																	'🎉 配置成功，',
																	h('b', ' 刷新网页后 '),
																	'重新进入',
																	h('b', ' 答题页面 '),
																	'即可。',
																	'解析到的题库如下所示:'
																]),
																...createAnswererWrapperList(awsResult)
															]),
															onConfirm: () => {
																if ($gm.isInGMContext()) {
																	top?.document.location.reload();
																}
															},
															...($gm.isInGMContext()
																? {
																		confirmButtonText: '立即刷新',
																		cancelButtonText: '稍后刷新'
																  }
																: {})
														});

														// 格式化文本
														textarea.value = JSON.stringify(awsResult, null, 4);

														// 检测 connects.length 是因为 如果在软件的软件设置全局配置中，上下文的 GM_info 会变成空
														if (connects.length) {
															// 检测是否有域名白名单
															const notAllowed: string[] = [];

															// 如果是通用版本，则不检测
															if (connects.includes('*')) {
																return;
															}

															for (const aw of awsResult) {
																if (connects.some((connect) => new URL(aw.url).hostname.includes(connect)) === false) {
																	notAllowed.push(aw.url);
																}
															}
															if (notAllowed.length) {
																$modal.alert({
																	width: 600,
																	maskCloseable: false,
																	title: '⚠️警告',
																	content: h('div', [
																		h('div', [
																			'配置成功，但检测到以下 域名/ip 不在脚本的白名单中，请安装 : ',
																			h(
																				'a',
																				{
																					href: 'https://docs.ocsjs.com/docs/other/api#全域名通用版本'
																				},
																				'OCS全域名通用版本'
																			),
																			'，或者手动添加 @connect ，否则无法进行请求。',
																			h(
																				'ul',
																				notAllowed.map((url) => h('li', new URL(url).hostname))
																			)
																		])
																	])
																});
															}
														}
													} catch (e: any) {
														$modal.alert({
															content: h('div', [h('div', '解析失败，原因如下 :'), h('div', e.message)])
														});
													}
												};
											})
										])
									])
								])
							});
						};
					}
				},
				upload: {
					label: '答题完成后',
					tag: 'select',
					defaultValue: 80 as WorkUploadType,
					options: [
						['save', '自动保存', '完成后自动保存答案, 注意如果你开启了随机作答, 有可能分辨不出答案是否正确。'],
						['nomove', '不保存也不提交', '等待时间过后将会自动下一节, 适合在测试脚本时使用。'],
						...([10, 20, 30, 40, 50, 60, 70, 80, 90].map((rate) => [
							rate,
							`搜到${rate}%的题目则自动提交`,
							`例如: 100题中查询到 ${rate} 题的答案,（答案不一定正确）, 则会自动提交。`
						]) as [any, string, string][]),
						['100', '每个题目都查到答案才自动提交', '答案不一定正确'],
						['force', '强制自动提交', '不管答案是否正确直接强制自动提交，如需开启，请配合随机作答谨慎使用。']
					],
					attrs: {
						title:
							'自动答题完成后的设置，目前仅在 超星学习通的章节测试 中生效, 鼠标悬浮在选项上可以查看每个选项的具体解释。'
					}
				},
				thread: {
					label: '线程数量（个）',
					attrs: {
						type: 'number',
						min: 1,
						step: 1,
						max: 3,
						title:
							'同一时间内答题线程工作的数量（例子：三个线程则代表一秒内同时搜索三道题），过多可能导致题库服务器压力过大，请适当调低。'
					},
					defaultValue: 1
				},
				'work-when-no-job': {
					defaultValue: false,
					label: '(仅超星)强制答题',
					attrs: {
						type: 'checkbox',
						title:
							'当章节测试左上角并没有黄色任务点的时候依然进行答题（没有任务点说明此作业可能不计入总成绩，如果老师要求则可以开启）'
					}
				},
				'randomWork-choice': {
					defaultValue: false,
					label: '(仅超星)随机选择',
					attrs: { type: 'checkbox', title: '题库搜索不到答案时，随机选择任意一个选项，仅支持超星章节测试' }
				},
				'randomWork-complete': {
					defaultValue: false,
					label: '(仅超星)随机填空',
					attrs: { type: 'checkbox', title: '题库搜索不到答案时，随机填写以下任意一个文案，仅支持超星章节测试' }
				},
				'randomWork-completeTexts-textarea': {
					defaultValue: ['不会', '不知道', '不清楚', '不懂', '不会写'].join('\n'),
					label: '(仅超星)随机填空文案',
					tag: 'textarea',
					showIf: 'common.settings.randomWork-complete',
					attrs: { title: '每行一个，随机填入', style: { minWidth: '200px', minHeight: '50px' } },
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				advancedSettings: {
					...dropdownStyle,
					defaultValue: false,
					label: '高级设置',
					attrs: { type: 'checkbox', title: '请谨慎使用高级设置，可能会影响答题效果，小白在未理解的情况下谨慎调整。' }
				},
				answerWrapperHandlerTimeout: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '搜题最大耗时（秒）',
					attrs: {
						type: 'number',
						min: 10,
						step: 1,
						max: 3 * 60,
						title: '搜题超时时间，单位为秒，超过这个时间直接放弃，进行下一题搜索。'
					},
					defaultValue: 120
				},
				stopSecondWhenFinish: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '答题结束后暂停（秒）',
					attrs: {
						type: 'number',
						min: 3,
						step: 1,
						max: 9999,
						title: '自动答题脚本结束后暂停的时间（方便查看和检查）。'
					},
					defaultValue: 3
				},
				period: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '搜题间隔（秒）',
					attrs: {
						type: 'number',
						min: 1,
						step: 1,
						max: 60,
						title: '每道题的搜题间隔时间，不建议太低，避免增加服务器压力。'
					},
					defaultValue: 3
				},
				answerSeparators: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					label: '答案分隔符',
					attrs: {
						title: "分隔答案的符号，例如：答案1#答案2#答案3，分隔符为 #， 使用英文逗号进行隔开 : ',' "
					},
					defaultValue: ['===', '#', '---', '###', '|', ';', '；'].join(','),
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				redundanceWordsText: {
					showIf: 'common.settings.advancedSettings',
					elementClassName: 'config-details',
					defaultValue: [
						'单选题(必考)',
						'填空题(必考)',
						'多选题(必考)',
						'(单选题)',
						'(多选题)',
						'(判断题)',
						'(填空题)',
						'【单选题】',
						'【多选题】',
						'【填空题】',
						'【判断题】',
						'【單選题】',
						'【多選题】',
						'【判斷题】',
						'【Single Choice】',
						'【Multiple Choice】',
						'【single choice】',
						'【multiple choice】',
						'【True or False】'
					].join('\n'),
					label: '题目冗余字段自动删除',
					tag: 'textarea',
					attrs: {
						title: '在搜题的时候自动删除多余的文字，以便提高搜题的准确度，每行一个。',
						style: { minWidth: '200px', minHeight: '50px' }
					},
					onload(el) {
						el.addEventListener('change', () => {
							if (String(el.value).trim() === '') {
								el.value = el.defaultValue;
							}
						});
					}
				},
				notification: {
					separator: '其他设置',
					label: '系统通知',
					attrs: {
						title:
							'允许脚本发送系统通知，只有重要事情发生时会发送系统通知，尽量避免用户受到骚扰（在电脑屏幕右侧显示通知弹窗，例如脚本执行完毕，图形验证码，版本更新等通知）。'
					},
					tag: 'select',
					defaultValue: 'only-notify' as 'only-notify' | 'notify-and-voice' | 'all' | 'no-notify',
					options: [
						['only-notify', '只显示右下角通知'],
						['notify-and-voice', '通知以及提示音（叮的一声）'],
						['all', '通知，提示音，以及任务栏闪烁提示'],
						['no-notify', '关闭系统通知']
					]
				},
				notificationWebhooks: {
					label: '通知回调',
					attrs: {
						title:
							// eslint-disable-next-line no-template-curly-in-string
							'发送系统通知时发送回调请求，用于专业开发人员对接其他通知系统。（每行填写一个URL，顺序发送GET请求，${message} 为消息占位符，可用于消息变量替换）'
					},
					tag: 'textarea',
					defaultValue: ''
				},
				enableQuestionCaches: {
					label: '题库缓存功能',
					defaultValue: true,
					attrs: { type: 'checkbox', title: '详情请前往 通用-其他应用-题库拓展查看。' }
				}
			},
			methods() {
				return {
					/**
					 * 获取自动答题配置，包括题库配置
					 */
					getWorkOptions: () => {
						// 使用 json 深拷贝，防止修改原始配置
						const workOptions: typeof this.cfg = JSON.parse(JSON.stringify(this.cfg));

						/**
						 * 过滤掉被禁用的题库
						 */
						workOptions.answererWrappers = workOptions.answererWrappers.filter(
							(aw) => this.cfg.disabledAnswererWrapperNames.find((daw) => daw === aw.name) === undefined
						);

						/**
						 * AI 大模型题库特殊处理：
						 * 存储里只有简单配置（url/key/model），这里用源码固定函数重建完整 wrapper，
						 * 确保 handler 总是源码最新版（避免用户存储里的旧坏 handler）。
						 */
						workOptions.answererWrappers = workOptions.answererWrappers.map((aw) =>
							aw.name === AI_WRAPPER_NAME ? buildAIWrapper(aw) : aw
						);

						return workOptions;
					},
					/**
					 * 根据全局设置的配置，发起通知
					 * @param content
					 * @param opts
					 */
					notificationBySetting: (
						content: string,
						opts?: {
							extraTitle?: string;
							/** 显示时间，单位为秒，默认为 30 秒， 0 则表示一直存在 */
							duration?: number;
							/** 通知点击时 */
							onclick?: () => void;
							/** 通知关闭时 */
							ondone?: () => void;
						}
					) => {
						if (this.cfg.notification !== 'no-notify') {
							$gm.notification(content, {
								extraTitle: opts?.extraTitle,
								duration: opts?.duration ?? 30,
								important: this.cfg.notification === 'all',
								silent: this.cfg.notification === 'only-notify'
							});

							const message = (opts?.extraTitle ? opts?.extraTitle + '：' : '') + content;

							const webhooks = this.cfg.notificationWebhooks
								.split('\n')
								.map((i) => i.trim())
								.filter(Boolean);

							for (const webhook of webhooks) {
								let resolved_webhook = webhook;
								// eslint-disable-next-line no-template-curly-in-string
								resolved_webhook = webhook.replace('${message}', encodeURIComponent(message));
								request(resolved_webhook, {
									method: 'get',
									type: 'GM_xmlhttpRequest'
								})
									.then((result) => {
										console.debug('通知回调成功', { webhook: resolved_webhook, result });
									})
									.catch((err) => {
										console.debug('通知回调失败', { webhook: resolved_webhook, err });
									});
							}
						}
					}
				};
			},
			// 实时更新内部设置
			oncomplete() {
				AnswerWrapperHandlerConfig.timeout_seconds = this.cfg.answerWrapperHandlerTimeout;
				this.onConfigChange('answerWrapperHandlerTimeout', (sec) => {
					AnswerWrapperHandlerConfig.timeout_seconds = sec;
				});
			},
			onrender({ panel }) {
				// 因为需要用到 GM_xhr 所以判断是否处于用户脚本环境
				if ($gm.isInGMContext()) {
					panel.body.replaceChildren(...(this.cfg.answererWrappers.length ? [h('hr')] : []));
					const testNotification = h(
						'button',
						{ className: 'base-style-button', disabled: this.cfg.answererWrappers.length === 0 },
						'📢测试系统通知'
					);
					testNotification.onclick = () => {
						this.methods.notificationBySetting('这是一条测试通知');
					};
					const refresh = h(
						'button',
						{ className: 'base-style-button', disabled: this.cfg.answererWrappers.length === 0 },
						'🔄️刷新题库状态'
					);
					const errorSolveGuide = h(
						'button',
						{
							className: 'base-style-button ',
							style: { display: 'none' },
							onclick() {
								window.open('https://docs.ocsjs.com/docs/other/FQA#tk-error', '_blank');
							}
						},
						'📖连接失败如何解决？'
					);
					refresh.onclick = () => {
						updateState();
					};
					const tableContainer = h('div');
					refresh.style.display = 'none';
					tableContainer.style.display = 'none';
					panel.body.append(
						h('div', { style: { display: 'flex' } }, [testNotification, refresh, errorSolveGuide]),
						tableContainer
					);

					// 更新题库状态
					const updateState = async () => {
						// 清空元素
						tableContainer.replaceChildren();
						errorSolveGuide.style.display = 'none';
						let loadedCount = 0;

						if (this.cfg.answererWrappers.length) {
							refresh.style.display = 'block';
							tableContainer.style.display = 'block';
							refresh.textContent = '🚫正在加载题库状态...';
							refresh.setAttribute('disabled', 'true');

							const table = h('table');
							table.style.width = '100%';
							this.cfg.answererWrappers.forEach(async (item) => {
								const t = Date.now();
								let success = false;
								let error;
								const isDisabled = this.cfg.disabledAnswererWrapperNames.find((name) => name === item.name);

								const res = isDisabled
									? false
									: await Promise.race([
											(async () => {
												try {
													return await request(new URL(item.url).origin + '/?t=' + t, {
														type: 'GM_xmlhttpRequest',
														method: 'head',
														responseType: 'text'
													});
												} catch (err) {
													error = err;
													return false;
												}
											})(),
											(async () => {
												await $.sleep(10 * 1000);
												return false;
											})()
									  ]);
								if (typeof res === 'string') {
									success = true;
								} else {
									success = false;
								}

								if (error) {
									errorSolveGuide.style.display = 'block';
								}

								const body = h('tbody');
								body.append(h('td', item.name));
								body.append(
									h('td', [
										$ui.tooltip(
											h(
												'span',
												{ title: isDisabled ? '题目已经被停用，请在上方题库配置中点击开启。' : '' },
												success ? '连接成功🟢' : isDisabled ? '已停用⚪' : error ? '连接失败🔴' : '连接超时🟡'
											)
										)
									])
								);
								body.append(h('td', `延迟 : ${success ? Date.now() - t : '---'}/ms`));
								table.append(body);
								loadedCount++;

								if (loadedCount === this.cfg.answererWrappers.length) {
									setTimeout(() => {
										refresh.textContent = '🔄️刷新题库状态';
										refresh.removeAttribute('disabled');
									}, 2000);
								}
							});
							tableContainer.append(table);
						} else {
							refresh.style.display = 'none';
							tableContainer.style.display = 'none';
						}
					};

					updateState();

					this.offConfigChange(state.setting.listenerIds.aw);
					state.setting.listenerIds.aw = this.onConfigChange('answererWrappers', (_, __, remote) => {
						if (remote === false) {
							updateState();
						}
					});
				}
			}
		}),
		workResults: new Script({
			name: '🔎 搜索结果',
			matches: [['所有页面', /.*/]],
			namespace: 'common.work-results',
			configs: {
				notes: {
					defaultValue: $ui.notes(['点击题目序号，查看搜索结果', '如果没有搜到，可能是题库没有收录该题目答案'])
						.outerHTML
				},
				/**
				 * 显示类型
				 * list: 显示为题目列表
				 * numbers: 显示为序号列表
				 */
				type: {
					label: '显示类型',
					tag: 'select',
					options: [
						['numbers', '序号列表'],
						['questions', '题目列表']
					],
					attrs: {
						title: '使用题目列表可能会造成页面卡顿。'
					},
					defaultValue: 'numbers' as 'questions' | 'numbers'
				},
				totalQuestionCount: {
					defaultValue: 0
				},
				requestedCount: {
					defaultValue: 0
				},
				resolvedCount: {
					defaultValue: 0
				},
				currentResultIndex: {
					defaultValue: 0
				},
				questionPositionSyncHandlerType: {
					defaultValue: undefined as keyof typeof state.workResult.questionPositionSyncHandler | undefined
				}
			},
			methods() {
				return {
					/**
					 * 从搜索结果中计算状态，并更新
					 */
					updateWorkStateByResults: (results: { requested: boolean; resolved: boolean }[]) => {
						this.cfg.totalQuestionCount = results.length;
						this.cfg.requestedCount = results.filter((result) => result.requested).length;
						this.cfg.resolvedCount = results.filter((result) => result.resolved).length;
					},
					/**
					 * 更新状态
					 */
					updateWorkState: (state: { totalQuestionCount: number; requestedCount: number; resolvedCount: number }) => {
						this.cfg.totalQuestionCount = state.totalQuestionCount;
						this.cfg.requestedCount = state.requestedCount;
						this.cfg.resolvedCount = state.resolvedCount;
					},
					/**
					 * 刷新状态
					 */
					refreshState: () => {
						this.cfg.totalQuestionCount = 0;
						this.cfg.requestedCount = 0;
						this.cfg.resolvedCount = 0;
					},
					/**
					 * 清空搜索结果
					 */
					clearResults: () => {
						return $store.setTab(TAB_WORK_RESULTS_KEY, []);
					},
					getResults(): Promise<SimplifyWorkResult[]> | undefined {
						return $store.getTab(TAB_WORK_RESULTS_KEY) || undefined;
					},
					setResults(results: SimplifyWorkResult[]) {
						return $store.setTab(TAB_WORK_RESULTS_KEY, results);
					},
					async appendResults(results: SimplifyWorkResult[]) {
						const data = (await $store.getTab(TAB_WORK_RESULTS_KEY)) || [];
						data.push(...results);
						return $store.setTab(TAB_WORK_RESULTS_KEY, data);
					},
					/**
					 * 刷新搜索结果状态，清空搜索结果，置顶搜索结果面板
					 */
					init(opts?: { questionPositionSyncHandlerType?: keyof typeof state.workResult.questionPositionSyncHandler }) {
						CommonProject.scripts.workResults.cfg.questionPositionSyncHandlerType =
							opts?.questionPositionSyncHandlerType;
						// 刷新搜索结果状态
						CommonProject.scripts.workResults.methods.refreshState();
						// 清空搜索结果
						CommonProject.scripts.workResults.methods.clearResults();
					},
					/**
					 * 创建搜索结果面板
					 * @param mount 挂载点
					 */
					createWorkResultsPanel: (mount?: HTMLElement) => {
						const container = mount || h('div');
						container.style.width = '400px';
						/** 记录滚动高度 */
						let scrollPercent = 0;

						/** 列表 */
						const list = h('div', { className: 'work-result-list' });

						/** 是否悬浮在题目上 */
						let mouseoverIndex = -1;

						list.onscroll = () => {
							scrollPercent = list.scrollTop / list.scrollHeight;
						};

						/** 给序号设置样式 */
						const setNumStyle = (result: SimplifyWorkResult, num: HTMLElement, index: number) => {
							if (result.requested) {
								num.classList.add('requested');
							}

							if (index === this.cfg.currentResultIndex) {
								num.classList.add('active');
							}

							if (result.finish) {
								num.classList.add('finish');
							} else {
								if (
									result.requested &&
									result.resolved &&
									(result.error?.trim().length !== 0 || result.searchInfos.length === 0 || result.finish === false)
								) {
									num.classList.add('error');
								}
							}
						};

						/** 渲染结果面板 */
						const render = debounce(async () => {
							const results: SimplifyWorkResult[] | undefined =
								await CommonProject.scripts.workResults.methods.getResults();

							if (results?.length) {
								// 如果序号指向的结果为空，则代表已经被清空，则重新让index变成0
								if (results[this.cfg.currentResultIndex] === undefined) {
									this.cfg.currentResultIndex = 0;
								}

								// 渲染序号或者题目列表
								if (this.cfg.type === 'numbers') {
									const resultContainer = h('div', { className: 'work-result-container' });

									list.style.marginBottom = '12px';
									list.style.overflow = 'auto';
									list.style.maxHeight = '300px';

									/** 渲染序号 */
									const nums = results.map((result, index) => {
										return h('span', { className: 'search-infos-num', innerText: (index + 1).toString() }, (num) => {
											setNumStyle(result, num, index);

											num.onclick = () => {
												for (const n of nums) {
													n.classList.remove('active');
												}
												num.classList.add('active');
												// 更新显示序号
												this.cfg.currentResultIndex = index;
												// 重新渲染结果列表
												resultContainer.replaceChildren(createResult(result));
												// 触发页面题目元素同步器
												if (this.cfg.questionPositionSyncHandlerType) {
													state.workResult.questionPositionSyncHandler[this.cfg.questionPositionSyncHandlerType]?.(
														index
													);
												}
											};
										});
									});

									list.replaceChildren(...nums);
									// 初始显示指定序号的结果
									resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));

									container.replaceChildren(list, resultContainer);
								} else {
									/** 左侧题目列表 */

									list.style.overflow = 'auto';
									list.style.maxHeight = window.innerHeight / 2 + 'px';

									/** 右侧结果 */
									const resultContainer = h('div', { className: 'work-result-question-container' });
									const nums: HTMLSpanElement[] = [];
									/** 左侧渲染题目列表 */
									const questions = results.map((result, index) => {
										/** 左侧序号 */
										const num = h(
											'span',
											{
												className: 'search-infos-num',
												innerHTML: (index + 1).toString()
											},
											(num) => {
												num.style.marginRight = '12px';
												num.style.display = 'inline-block';
												setNumStyle(result, num, index);
											}
										);

										nums.push(num);

										return h(
											'div',

											[num, result.question],
											(question) => {
												question.onmouseover = () => {
													mouseoverIndex = index;
													// 重新渲染结果列表
													resultContainer.replaceChildren(createResult(result));
												};

												question.onmouseleave = () => {
													mouseoverIndex = -1;
													// 重新显示指定序号的结果
													resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));
												};

												question.onclick = () => {
													for (const n of nums) {
														n.classList.remove('active');
													}
													for (const q of questions) {
														q.classList.remove('active');
													}
													nums[index].classList.add('active');
													question.classList.add('active');
													// 更新显示序号
													this.cfg.currentResultIndex = index;
													// 重新渲染结果列表
													resultContainer.replaceChildren(createResult(result));
													// 触发页面题目元素同步器
													if (this.cfg.questionPositionSyncHandlerType) {
														state.workResult.questionPositionSyncHandler[this.cfg.questionPositionSyncHandlerType]?.(
															index
														);
													}
												};
											}
										);
									});

									list.replaceChildren(...questions);
									// 初始显示指定序号的结果
									if (mouseoverIndex === -1) {
										resultContainer.replaceChildren(createResult(results[this.cfg.currentResultIndex]));
									} else {
										resultContainer.replaceChildren(createResult(results[mouseoverIndex]));
									}

									container.replaceChildren(
										h('div', [list, h('div', {}, [resultContainer])], (div) => {
											div.style.display = 'flex';
										})
									);
								}
							} else {
								container.replaceChildren(
									h('div', { className: 'alert-info-wrapper' }, [
										h('div', '暂无任何搜索结果~', (div) => {
											div.style.marginTop = '12px';
											div.className = 'result-info no-answer';
										})
									])
								);
							}

							/** 恢复高度 */
							list.scrollTo({
								top: scrollPercent * list.scrollHeight,
								behavior: 'auto'
							});

							const tip = h('div', [
								h('div', { className: 'search-infos-num' }, '1'),
								' 表示等待处理中',
								h('br'),
								h('div', { className: 'search-infos-num requested' }, '1'),
								' 表示已完成搜索 ',
								h('br'),
								h('div', { className: 'search-infos-num finish' }, '1'),
								' 表示已搜索已答题 '
							]);

							/** 添加信息 */
							container.prepend(
								h('hr'),
								h(
									'div',
									[
										$ui.space(
											[
												h('span', `已搜题: ${this.cfg.requestedCount}/${this.cfg.totalQuestionCount}`),
												h('span', `已答题: ${this.cfg.resolvedCount}/${this.cfg.totalQuestionCount}`),
												h('a', '提示', (btn) => {
													btn.style.cursor = 'pointer';
													btn.onclick = () => {
														$modal.confirm({ content: tip, footer: undefined });
													};
												}),
												$ui.tooltip(
													h('a', '清空结果', (btn) => {
														btn.title = '仅用于不会自动清空搜索结果的场景，例如超星非整卷预览模式';
														btn.style.cursor = 'pointer';
														btn.onclick = () => {
															this.methods.clearResults();
															const { panel, header } = CXProject.scripts.work;
															if (panel && header) {
																CXProject.scripts.work.onrender?.({ panel, header });
																CommonProject.scripts.workResults.onrender?.({ panel, header });
															}
														};
													})
												)
											],
											{ separator: '|' }
										)
									],
									(div) => {
										div.style.textAlign = 'center';
										div.style.fontSize = '12px';
									}
								)
							);
						}, 100);

						/** 渲染结果列表 */
						const createResult = (result: SimplifyWorkResult | undefined) => {
							if (result) {
								return h('div', [
									createSearchResultAlertElement(result),
									h(SearchInfosElement, {
										infos: result.searchInfos,
										question: result.question,
										type: result.type
									})
								]);
							} else {
								return h('div', 'undefined');
							}
						};

						render();
						this.onConfigChange('type', render);
						this.onConfigChange('requestedCount', render);
						this.onConfigChange('resolvedCount', render);
						$store.addChangeListener(TAB_WORK_RESULTS_KEY, render);

						return container;
					}
				};
			},
			onrender({ panel }) {
				panel.body.replaceChildren(this.methods.createWorkResultsPanel());
			}
		}),
		onlineSearch: new Script({
			name: '🔎 在线搜题',
			matches: [['所有页面', /.*/]],
			namespace: 'common.online-search',
			configs: {
				notes: {
					defaultValue: '查题前请在 “通用-全局设置” 中设置题库配置，才能进行在线搜题。'
				},

				selectSearch: {
					label: '划词搜索',
					defaultValue: true,
					attrs: { type: 'checkbox', title: '使用鼠标滑动选择页面中的题目进行搜索。' }
				},
				searchValue: {
					sync: true,
					label: '搜索题目',
					tag: 'textarea',
					attrs: {
						placeholder: '输入题目，请尽量保证题目完整，不要漏字',
						style: {
							minWidth: '300px',
							minHeight: '64px'
						}
					},
					defaultValue: ''
				}
			},
			oncomplete() {
				document.addEventListener(
					'selectionchange',
					debounce(() => {
						if (this.cfg.selectSearch) {
							const val = document.getSelection()?.toString() || '';
							if (val) {
								this.cfg.searchValue = val;
							}
						}
					}, 500)
				);
			},
			onrender({ panel }) {
				const content = h('div', '', (content) => {
					content.style.marginBottom = '12px';
				});

				const search = async (value: string) => {
					if (CommonProject.scripts.settings.cfg.answererWrappers.length === 0) {
						$modal.alert({ content: '请先在 通用-全局设置 配置题库，才能进行在线搜题。' });
						return;
					}

					content.replaceChildren(h('span', '搜索中...'));

					if (value) {
						const t = Date.now();
						const infos = await defaultAnswerWrapperHandler(CommonProject.scripts.settings.cfg.answererWrappers, {
							title: value
						});
						// 耗时计算
						const resume = ((Date.now() - t) / 1000).toFixed(2);

						content.replaceChildren(
							h(
								'div',
								[
									h('hr'),
									h(
										'div',
										{ style: { color: '#a1a1a1' } },
										`搜索到 ${infos.map((i) => i.results).flat().length} 个结果，共耗时 ${resume} 秒`
									),
									h(SearchInfosElement, {
										infos: infos.map((info) => ({
											results: info.results.map(
												(res) => [res.question, res.answer, res.extra_data] as [string, string, object]
											),
											homepage: info.homepage,
											name: info.name,
											error: info.error
										})),
										question: value
									})
								],
								(div) => {
									div.classList.add('card');
									div.style.width = '480px';
								}
							)
						);
					} else {
						content.replaceChildren(h('span', '题目不能为空！'));
					}
				};

				const button = h('button', '搜索', (button) => {
					button.className = 'base-style-button';
					button.style.width = '120px';
					button.onclick = () => {
						search(this.cfg.searchValue);
					};
				});
				const searchContainer = h('div', { style: { textAlign: 'end' } }, [button]);

				panel.body.append(h('div', [content, searchContainer]));
			}
		}),
		/** 渲染脚本，窗口渲染主要脚本 */
		render: RenderScript,
		hack: new Script({
			name: '页面复制粘贴限制解除',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			onactive() {
				enableCopy([document, document.body]);
			},
			oncomplete() {
				enableCopy([document, document.body]);
				insertCopyableStyle();
				setTimeout(() => {
					enableCopy([document, document.body]);
					insertCopyableStyle();
				}, 3000);
			}
		}),
		disableDialog: new Script({
			name: '禁止弹窗',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			priority: 1,
			onstart() {
				function disableDialog(msg: string) {
					$modal.alert({
						profile: '弹窗来自：' + location.origin,
						content: msg
					});
				}

				try {
					$gm.unsafeWindow.alert = disableDialog;
					window.alert = disableDialog;
				} catch (e) {
					console.error(e);
				}
			}
		}),
		apps: new Script({
			name: '📱 拓展应用',
			matches: [['', /.*/]],
			namespace: 'common.apps',
			configs: {
				notes: {
					defaultValue: '这里是一些其他的应用或者拓展功能。'
				},
				/**
				 * 题库缓存
				 */
				localQuestionCaches: {
					defaultValue: [] as QuestionCache[],
					extra: {
						appConfigSync: false
					}
				}
			},
			methods() {
				return {
				/**
				 * 添加题库缓存
				 *
				 * 去重/覆盖语义：
				 * - 同 title + 同 type（type 缺失时仅按 title）视为同一题，覆盖为最新答案。
				 *   原因：闯关结算页每次记录的都是"本次的正确答案"，旧记录（尤其选项字母已失效的）
				 *   应被替换，避免重答时命中过时答案。
				 * - type 参与判定：同一题干在判断题/单选题等不同题型下答案不同时分别保留。
				 * - 向后兼容：旧缓存/未传 type 的课程（type 为 undefined），退化为仅按 title 去重，
				 *   行为与改动前一致。
				 */
					addQuestionCache: async (...questionCacheItems: QuestionCache[]) => {
						const questionCaches: QuestionCache[] = this.cfg.localQuestionCaches;
						for (const item of questionCacheItems) {
							// 同题同型覆盖：移除所有命中项，再 unshift 新的（保证只保留最新）
							for (let i = questionCaches.length - 1; i >= 0; i--) {
								const c = questionCaches[i];
								const sameTitle = c.title === item.title;
								const sameType = (c.type || undefined) === (item.type || undefined);
								if (sameTitle && sameType) {
									questionCaches.splice(i, 1);
								}
							}
							questionCaches.unshift(item);
						}

						// 限制数量
						questionCaches.splice(200);
						this.cfg.localQuestionCaches = questionCaches;
					},
					addQuestionCacheFromWorkResult(swr: SimplifyWorkResult[]) {
						CommonProject.scripts.apps.methods.addQuestionCache(
							...swr
								.map((r) =>
									r.searchInfos
										.map((i) =>
											i.results
												.filter((res) => res[1])
												.map((res) => ({
													title: r.question,
													answer: res[1],
													from: i.name.replace(/【题库缓存】/g, ''),
													homepage: i.homepage || ''
												}))
												.flat()
										)
										.flat()
								)
								.flat()
						);
					},
					/**
					 * 将题库缓存作为题库并进行题目搜索
					 * @param title 题目
					 * @param whenSearchEmpty 当搜索结果为空，或者题库缓存功能被关闭时执行的函数
					 * @param type 题型（可选）。传入时按 title+type 精确匹配，避免同一题干在不同题型下答案冲突；
					 *             不传时退化为仅按 title 匹配（向后兼容，cx/icourse/icve/zhs 等行为不变）。
					 */
					searchAnswerInCaches: async (
						title: string,
						whenSearchEmpty: () => SearchInformation[] | Promise<SearchInformation[]>,
						type?: string
					): Promise<SearchInformation[]> => {
						if (CommonProject.scripts.settings.cfg.enableQuestionCaches === false) {
							return await whenSearchEmpty();
						}

						let results: SearchInformation[] = [];
						const caches = this.cfg.localQuestionCaches;
						for (const cache of caches) {
							const titleMatch = cache.title.trim() === title.trim();
							// type 参与匹配：传了 type 时必须一致；没传 type 时仅按 title（向后兼容）
							const typeMatch = type === undefined || (cache.type || undefined) === (type || undefined);
							if (titleMatch && typeMatch) {
								results.push({
									name: cache.from,
									homepage: cache.homepage,
									results: [{ answer: cache.answer, question: cache.title, extra_data: { ai: cache.ai, cache: true } }]
								});
							}
						}
						if (results.length === 0) {
							results = await whenSearchEmpty();
						}
						return results;
					},
					/**
					 * 查看更新日志
					 */
					async showChangelog() {
						const changelog = h('div', {
							className: 'markdown card',
							innerHTML: '加载中...',
							style: { maxWidth: '600px' }
						});
						$modal.simple({
							width: 600,
							content: h('div', [
								h('div', { className: 'notes card' }, [
									$ui.notes(['此页面实时更新，遇到问题可以查看最新版本是否修复。'])
								]),
								changelog
							])
						});
						const md = await request('https://cdn.ocsjs.com/articles/ocs/changelog.md?t=' + Date.now(), {
							type: 'GM_xmlhttpRequest',
							responseType: 'text',
							method: 'get'
						});
						changelog.innerHTML = markdown(md);
					}
				};
			},
			onrender({ panel }) {
				const btnStyle: Partial<CSSStyleDeclaration> = {
					padding: '6px 12px',
					margin: '4px',
					marginBottom: '8px',
					boxShadow: '0px 0px 4px #bebebe',
					borderRadius: '8px',
					cursor: 'pointer'
				};

				const cachesBtn = h('div', { innerText: '💾 题库缓存', style: btnStyle }, (btn) => {
					btn.onclick = () => {
						const questionCaches = this.cfg.localQuestionCaches;

						const list = questionCaches.map((c) =>
							h(
								'div',
								{
									className: 'question-cache',
									style: {
										margin: '8px',
										border: '1px solid lightgray',
										borderRadius: '4px',
										padding: '8px'
									}
								},
								[
									h('div', { className: 'title' }, [
										$ui.tooltip(
											h(
												'span',
												{
													title: `来自：${c.from || '未知题库'}\n主页：${c.homepage || '未知主页'}`,
													style: { fontWeight: 'bold' }
												},
												c.title
											)
										)
									]),
									h('div', { className: 'answer', style: { marginTop: '6px' } }, c.answer)
								]
							)
						);

						const countEl = h('span', ['当前缓存数量：' + questionCaches.length]);

						$modal.simple({
							width: 800,
							content: h('div', [
								h('div', { className: 'notes card' }, [
									$ui.notes([
										'题库缓存是将题库的题目和答案保存在内存，在重复使用时可以直接从内存获取，不需要再次请求题库。',
										'以下是当前存储的题库，默认存储200题，当前页面关闭后会自动清除。'
									])
								]),
								h('div', { className: 'card' }, [
									$ui.space(
										[
											countEl,
											$ui.button('清空题库缓存', {}, (btn) => {
												btn.onclick = () => {
													this.cfg.localQuestionCaches = [];
													countEl.innerText = '当前缓存数量：0';
													list.forEach((el) => el.remove());
												};
											})
										],
										{ separator: '|' }
									)
								]),

								h(
									'div',
									questionCaches.length === 0 ? [h('div', { style: { textAlign: 'center' } }, '暂无题库缓存')] : list
								)
							])
						});
					};
				});

				const exportSetting = $ui.tooltip(
					h(
						'div',
						{
							innerText: '📤 导出全部设置',
							style: btnStyle,
							title: '导出全部页面的设置，包括全局设置，题库配置，学习设置等等。（文件后缀名为：.ocssetting）'
						},
						(btn) => {
							btn.onclick = () => {
								const setting = Object.create({});
								for (const key of $store.list()) {
									const val = $store.get(key);
									if (val) {
										Reflect.set(setting, key, val);
									}
								}
								const blob = new Blob([JSON.stringify(setting, null, 2)], { type: 'text/plain' });
								const url = URL.createObjectURL(blob);
								const a = h('a', { href: url, download: 'ocs-setting-export.ocssetting' });
								a.click();
								URL.revokeObjectURL(url);
							};
						}
					)
				);

				const importSetting = $ui.tooltip(
					h(
						'div',
						{
							innerText: '📥 导入全部设置',
							style: btnStyle,
							title: '导入并且覆盖当前的全部设置。（文件后缀名为：.ocssetting）'
						},
						(btn) => {
							btn.onclick = () => {
								const input = h('input', { type: 'file', accept: '.ocssetting' });
								input.onchange = async () => {
									const file = input.files?.[0];
									if (file) {
										const setting = await file.text();
										const obj = JSON.parse(setting);
										for (const key of Object.keys(obj)) {
											$store.set(key, obj[key]);
										}
										$message.success({ content: '设置导入成功，页面即将刷新。', duration: 3 });
										setTimeout(() => {
											location.reload();
										}, 3000);
									}
								};
								input.click();
							};
						}
					)
				);

				[cachesBtn, exportSetting, importSetting].forEach((btn) => {
					btn.onmouseover = () => {
						btn.style.boxShadow = '0px 0px 4px #0099ff9c';
					};
					btn.onmouseout = () => {
						btn.style.boxShadow = '0px 0px 4px #bebebe';
					};
				});

				const sep = (text: string) => h('div', { className: 'separator', style: { padding: '4px 0px' } }, text);

				panel.body.replaceChildren(
					h('div', [sep('题库拓展'), cachesBtn, sep('其他功能'), exportSetting, importSetting])
				);
			}
		})
	}
});

function insertCopyableStyle() {
	const style = document.createElement('style');
	style.innerHTML = `
		html * {
		  -webkit-user-select: text !important;
		  -khtml-user-select: text !important;
		  -moz-user-select: text !important;
		  -ms-user-select: text !important;
		  user-select: text !important;
		}`;

	document.head.append(style);
}

function createAnswererWrapperList(aw: AnswererWrapper[]) {
	return aw.map((item) =>
		h(
			'details',
			[
				h('summary', [
					$ui.space([
						(() => {
							let isDisabled = CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames.includes(item.name);

							const checkbox = h('input', { type: 'checkbox', checked: !isDisabled, className: 'base-style-switch' });

							checkbox.onclick = () => {
								isDisabled = !isDisabled;
								if (isDisabled) {
									CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames = [
										...CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames,
										item.name
									];
									$message.warn({
										content: '题库：' + item.name + ' 已被停用，如需开启请在：通用-全局设置-题库配置中开启。',
										duration: 30
									});
								} else {
									CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames =
										CommonProject.scripts.settings.cfg.disabledAnswererWrapperNames.filter(
											(name) => name !== item.name
										);
									$message.success({
										content: '题库：' + item.name + ' 已启用。',
										duration: 3
									});
								}
							};

							checkbox.title = '点击停用或者启用题库，停用题库后将无法在自动答题中查询题目';

							return $ui.tooltip(checkbox);
						})(),
						h('span', item.name)
					])
				]),
				h('ul', [
					h('li', ['名字\t', item.name]),
					h('li', { innerHTML: `官网\t<a target="_blank" href=${item.homepage}>${item.homepage || '无'}</a>` }),
					h('li', ['接口\t', item.url]),
					h('li', ['请求方法\t', item.method]),
					h('li', ['请求类型\t', item.type]),
					h('li', ['请求头\t', JSON.stringify(item.headers, null, 4) || '无']),
					h('li', ['请求体\t', JSON.stringify(item.data, null, 4) || '无'])
				])
			],
			(details) => {
				details.style.paddingLeft = '12px';
			}
		)
	);
}

const createGuide = () => {
	const showProjectDetails = (project: Project) => {
		$modal.simple({
			title: project.name,
			width: 800,
			content: h('div', [
				h('div', [
					'运行域名：',
					...(project.domains || []).map((d) =>
						h(
							'a',
							{ href: d.startsWith('http') ? d : 'https://' + d, target: '_blank', style: { margin: '0px 4px' } },
							d
						)
					)
				]),
				h('div', '脚本列表：'),
				h(
					'ul',
					Object.keys(project.scripts)
						.sort((a, b) => (project.scripts[b].hideInPanel ? -1 : 1))
						.map((key) => {
							const script = project.scripts[key];
							return h(
								'li',
								[
									h('b', script.name),
									$ui.notes([
										h('span', ['操作面板：', script.hideInPanel ? '隐藏' : '显示']),

										[
											'运行页面：',
											h(
												'ul',
												script.matches
													.map((m) => (Array.isArray(m) ? m : (['无描述', m] as [string, string | RegExp])))
													.map((i) =>
														h('li', [
															i[0],
															'：',
															i[1] instanceof RegExp ? i[1].toString().replace(/\\/g, '').slice(1, -1) : h('span', i[1])
														])
													)
											)
										]
									])
								],
								(li) => {
									li.style.marginBottom = '12px';
								}
							);
						}),
					(ul) => {
						ul.style.padding = '12px 24px';
						ul.style.border = '1px solid #e1e1e1';
						ul.style.borderRadius = '4px';
						ul.style.maxHeight = '400px';
						ul.style.overflow = 'auto';
						ul.style.paddingLeft = '42px';
					}
				)
			])
		});
	};

	const gotoHome = h('button', { className: 'base-style-button-secondary' }, '🏡官网教程');
	gotoHome.onclick = () => window.open('https://docs.ocsjs.com', '_blank');

	const contactUs = h('button', { className: 'base-style-button-secondary' }, '🗨️交流群');
	contactUs.onclick = () => window.open('https://docs.ocsjs.com/docs/about#交流方式', '_blank');

	const changeLog = h('button', { className: 'base-style-button-secondary' }, '📄更新日志');
	changeLog.onclick = () => CommonProject.scripts.apps.methods.showChangelog();

	const closeGuide = h('button', { className: 'base-style-button-secondary' }, '📄如何关闭脚本？');
	closeGuide.onclick = () =>
		window.open('https://docs.ocsjs.com/docs/script#%E5%85%B3%E9%97%AD%E8%84%9A%E6%9C%AC%E6%95%99%E7%A8%8B', '_blank');

	const cardStyle: Partial<CSSStyleDeclaration> = {
		border: '1px solid #eee',
		borderRadius: '4px',
		padding: '8px',
		paddingTop: '4px'
	};

	return h('div', { className: 'user-guide' }, [
		h('div', { style: cardStyle }, [
			h('div', { style: { marginBottom: '4px', fontWeight: 'bold' } }, [
				'✨兼容的网课平台：',
				h('span', { className: 'secondary', style: { fontWeight: 'normal' } }, '（未适配的平台将无法运行，请等待适配）')
			]),

			h('div', [
				...[CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject, YKTProject].map((project) => {
					const btn = h('button', { className: 'base-style-button-secondary', style: { margin: '4px' } }, [
						project.name
					]);
					btn.onclick = () => {
						showProjectDetails(project);
					};
					return btn;
				})
			])
		]),
		h('div', { style: { ...cardStyle, marginTop: '12px' } }, [
			h('div', { style: { marginBottom: '8px', fontWeight: 'bold' } }, '🌐快捷访问：'),
			gotoHome,
			contactUs,
			changeLog,
			closeGuide
		])
	]);
};

function createSearchResultAlertElement(result: SimplifyWorkResult) {
	let info: HTMLElement | null = null;
	let err = result.error || result.searchInfos.find((i) => i.error)?.error;
	if (result.requested === false && result.resolved === false) {
		info = h('div', { className: 'result-info unresolved' }, '等待搜索中... 🔍');
	} else if (err) {
		let href = '#';
		if (err?.includes('is not valid JSON')) {
			err = '题库返回数据错误';
			href = 'https://docs.ocsjs.com/docs/other/FQA#tk-data-error';
		} else if (err?.includes('题库连接失败')) {
			err = '题库连接失败';
			href = 'https://docs.ocsjs.com/docs/other/FQA#tk-error';
		}
		info = h('div', { className: 'result-info error' }, [
			'❌ ' + err,
			h('a', { href, target: '_blank', style: { marginLeft: '3px' } }, '解决方法?')
		]);
	} else if (result.searchInfos.length === 0) {
		info = h('div', { className: 'result-info no-answer' }, '❌ 题库没搜索到答案');
	} else {
		info = result.finish
			? null
			: result.resolved === false
			? h('div', { className: 'result-info unresolved' }, '等待顺序答题中... ⏱️')
			: h('div', { className: 'result-info error' }, '❌ 此题未完成, 可能是没有匹配的选项。');
	}

	return h('div', { className: 'alert-info-wrapper' }, [info ?? h('div')]);
}

/**
 * AI 大模型题库配置面板
 *
 * 专用配置界面：三个清晰输入框（地址/Key/模型名）+ 测试连接按钮。
 * 测试按钮会发一条真实的 chat/completions 请求，验证地址、Key、模型是否可用。
 *
 * @returns 配置对象，用户取消返回 null
 */
function showAIConfigPanel(
	initUrl: string,
	initKey: string,
	initModel: string
): Promise<{ url: string; key: string; model: string } | null> {
	return new Promise((resolve) => {
		const urlInput = h('input', {
			className: 'base-style-active-form-control',
			style: { width: '100%', margin: '4px 0 6px', padding: '6px 10px', boxSizing: 'border-box' },
			placeholder: 'https://api.deepseek.com/v1  或  https://api.openai.com/v1/chat/completions',
			value: initUrl
		}) as HTMLInputElement;
		const keyInput = h('input', {
			className: 'base-style-active-form-control',
			style: { width: '100%', margin: '4px 0 6px', padding: '6px 10px', boxSizing: 'border-box' },
			placeholder: 'sk-xxxxxxxx...',
			value: initKey
		}) as HTMLInputElement;
		const modelInput = h('input', {
			className: 'base-style-active-form-control',
			style: { width: '100%', margin: '4px 0 6px', padding: '6px 10px', boxSizing: 'border-box' },
			placeholder: 'gpt-4o-mini / deepseek-chat / qwen-plus ...',
			value: initModel
		}) as HTMLInputElement;

		// 测试结果展示区
		const statusEl = h('div', {
			style: { margin: '8px 0', minHeight: '24px', fontSize: '13px', padding: '6px 10px', borderRadius: '4px' }
		}) as HTMLDivElement;

		// 测试连接按钮
		let testing = false;
		const testBtn = h(
			'button',
			{
				className: 'base-style-button',
				onclick: async () => {
					if (testing) return;
					const url = urlInput.value.trim();
					const key = keyInput.value.trim();
					const model = modelInput.value.trim() || 'gpt-3.5-turbo';
					if (!url || !key) {
						statusEl.style.background = '#fff3cd';
						statusEl.style.color = '#856404';
						statusEl.textContent = '⚠️ 请先填写 API 地址和 Key';
						return;
					}
					testing = true;
					testBtn.textContent = '测试中...';
					testBtn.setAttribute('disabled', 'true');
					statusEl.style.background = '#e7f5ff';
					statusEl.style.color = '#1971c2';
					statusEl.textContent = '🔄 正在请求，请稍候（首次可能较慢）...';

					// 自动补全地址
					let apiUrl = url.replace(/\/$/, '');
					if (!apiUrl.includes('/chat/completions')) {
						apiUrl = apiUrl.includes('/v1') ? apiUrl + '/chat/completions' : apiUrl + '/v1/chat/completions';
					}

					const startTime = Date.now();
					try {
						const res: any = await Promise.race([
							request(apiUrl, {
								method: 'post',
								type: 'GM_xmlhttpRequest',
								responseType: 'json',
								headers: {
									'Content-Type': 'application/json',
									Authorization: 'Bearer ' + key
								},
								data: {
									model,
									temperature: 0.1,
									max_tokens: 10,
									messages: [
										{ role: 'system', content: '只回复"OK"' },
										{ role: 'user', content: '回复OK' }
									]
								}
							}),
							$.sleep(30000).then(() => {
								throw new Error('请求超时（30秒），请检查地址是否正确或网络是否通畅');
							})
						]);
						const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
						const reply = res?.choices?.[0]?.message?.content;
						if (reply !== undefined) {
							statusEl.style.background = '#d3f9d8';
							statusEl.style.color = '#2b8a3e';
							statusEl.textContent = `✅ 连接成功！耗时 ${elapsed}s，模型回复："${String(reply).trim().slice(0, 30)}"`;
						} else {
							statusEl.style.background = '#fff3cd';
							statusEl.style.color = '#856404';
							statusEl.textContent = `⚠️ 连接成功但响应格式异常：${JSON.stringify(res).slice(0, 80)}`;
						}
					} catch (e: any) {
						const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
						statusEl.style.background = '#ffe3e3';
						statusEl.style.color = '#c92a2a';
						let msg = e?.message || String(e);
						// 常见错误友好提示
						if (/401|Unauthorized|invalid.*api.*key/i.test(msg)) {
							msg = 'API Key 无效或已过期（401），请检查 Key 是否正确';
						} else if (/404|not found/i.test(msg)) {
							msg = '地址或模型名不存在（404），请检查地址路径和模型名拼写';
						} else if (/model/i.test(msg)) {
							msg = '模型名错误：' + msg + '（请确认服务商支持的模型名）';
						}
						statusEl.textContent = `❌ 连接失败（${elapsed}s）：${msg}`;
					} finally {
						testing = false;
						testBtn.textContent = '🔌 测试连接';
						testBtn.removeAttribute('disabled');
					}
				}
			},
			'🔌 测试连接'
		) as HTMLButtonElement;

		// 移除可能的旧弹窗
		document.querySelectorAll('.ocs-ai-config-modal-mask').forEach((el) => el.remove());

		const mask = h(
			'div',
			{
				className: 'ocs-ai-config-modal-mask',
				style: {
					position: 'fixed',
					inset: '0',
					background: 'rgba(0,0,0,0.5)',
					zIndex: '2147483647',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center'
				}
			},
			[
				h(
					'div',
					{
						style: {
							background: '#fff',
							borderRadius: '8px',
							width: '520px',
							maxWidth: '90vw',
							maxHeight: '90vh',
							overflow: 'auto',
							padding: '20px 24px',
							boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
						}
					},
					[
						h('div', { style: { fontSize: '18px', fontWeight: 'bold', marginBottom: '4px' } }, '🤖 AI 大模型题库配置'),
						h(
							'div',
							{ style: { fontSize: '13px', color: '#666', marginBottom: '14px' } },
							'接入 OpenAI 兼容协议的中转站（GPT/DeepSeek/Kimi/通义/智谱等）。建议先点「测试连接」验证配置。'
						),
						h('label', { style: { display: 'block', fontWeight: 'bold', fontSize: '13px' } }, '① API 请求地址'),
						urlInput,
						h('div', { className: 'secondary', style: { fontSize: '12px', marginBottom: '8px' } }, '填到 /v1 即可，会自动补全。示例：https://api.deepseek.com/v1'),
						h('label', { style: { display: 'block', fontWeight: 'bold', fontSize: '13px' } }, '② API Key'),
						keyInput,
						h('div', { className: 'secondary', style: { fontSize: '12px', marginBottom: '8px' } }, '以 sk- 开头的密钥，在模型服务商控制台获取'),
						h('label', { style: { display: 'block', fontWeight: 'bold', fontSize: '13px' } }, '③ 模型名'),
						modelInput,
						h(
							'div',
							{ className: 'secondary', style: { fontSize: '12px', marginBottom: '8px' } },
							'常见：gpt-4o-mini / gpt-3.5-turbo / deepseek-chat / qwen-plus / glm-4-flash'
						),
						statusEl,
						h(
							'div',
							{ style: { marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'space-between' } },
							[
								testBtn,
								h('div', { style: { display: 'flex', gap: '8px' } }, [
									h(
										'button',
										{
											className: 'base-style-button',
											onclick: () => {
												mask.remove();
												resolve(null);
											}
										},
										'取消'
									),
									h(
										'button',
										{
											className: 'base-style-button',
											style: { background: '#1971c2', color: '#fff' },
											onclick: () => {
												const url = urlInput.value.trim();
												const key = keyInput.value.trim();
												const model = modelInput.value.trim() || 'gpt-3.5-turbo';
												if (!url || !key) {
													statusEl.style.background = '#fff3cd';
													statusEl.style.color = '#856404';
													statusEl.textContent = '⚠️ 地址和 Key 不能为空';
													return;
												}
												mask.remove();
												resolve({ url, key, model });
											}
										},
										'💾 保存配置'
									)
								])
							]
						)
					]
				)
			]
		) as HTMLDivElement;
		document.body.appendChild(mask);
	});
}

/**
 * 创建 AI 大模型题库的 AnswererWrapper（OpenAI 兼容协议）
 *
 * ⚠️ 重要：这里只存储简单配置（url/key/model），handler 留占位。
 *    真正的 handler 逻辑由 buildAIWrapper 运行时用源码固定函数生成，
 *    避免 handler 字符串序列化进用户存储后无法随源码更新。
 *
 * @param opts.url      API 请求地址（需包含 /v1/chat/completions）
 * @param opts.key      API Key（sk-xxx）
 * @param opts.model    模型名（如 gpt-4o-mini / deepseek-chat）
 */
function createAIAnswererWrapper(opts: { url: string; key: string; model: string }): AnswererWrapper {
	return {
		name: 'AI大模型题库',
		url: opts.url,
		homepage: 'https://platform.openai.com/docs/api-reference',
		method: 'post',
		type: 'GM_xmlhttpRequest',
		contentType: 'json',
		headers: {},
		// 用 data 存储配置参数，handler 占位（运行时由 buildAIWrapper 重建）
		data: { _aiKey: opts.key, _aiModel: opts.model },
		handler: 'return undefined'
	};
}

/** AI 题库固定标识：用于在 getWorkOptions 出口识别并重建 AI wrapper */
const AI_WRAPPER_NAME = 'AI大模型题库';

/**
 * 运行时重建 AI wrapper（在 getWorkOptions 出口调用）
 *
 * 从简单配置（url + data._aiKey + data._aiModel）生成完整的 OpenAI 兼容 wrapper，
 * handler 用源码里经过验证的固定函数。这样即使用户存储里是旧版坏 handler，
 * 出口处也会用正确的源码覆盖，彻底杜绝 handler 字符串注入问题。
 *
 * 兼容旧版配置：旧版把 key 存在 headers.Authorization，model 存在 data.model
 */
function buildAIWrapper(stored: AnswererWrapper): AnswererWrapper {
	// 兼容新旧两种存储格式提取 key 和 model
	const key =
		stored.data?._aiKey ||
		(stored.headers?.Authorization || '').replace(/^Bearer\s+/i, '') ||
		'';
	const model = stored.data?._aiModel || stored.data?.model || 'gpt-3.5-turbo';
	return {
		name: AI_WRAPPER_NAME,
		url: stored.url,
		homepage: 'https://platform.openai.com/docs/api-reference',
		method: 'post',
		type: 'GM_xmlhttpRequest',
		contentType: 'json',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ' + key
		},
		data: {
			model,
			temperature: 0.1,
			messages: {
				handler: aiMessagesHandlerSource
			}
		},
		handler: aiResponseHandlerSource
	};
}

/**
 * AI messages handler 源码字符串（构造 OpenAI 请求的 prompt）
 *
 * ⚠️ 严格规则（避免重蹈转义覆辙）：
 * - 禁止使用 // 单行注释（压缩成一行后会吞掉后续代码）
 * - 禁止使用反引号模板字符串
 * - 禁止直接写 \n （多层转义会出错），换行用 String.fromCharCode(10) 动态生成
 * - 只用双引号字符串 + 字符串拼接
 */
const aiMessagesHandlerSource =
	'return (env) => {' +
	'  var NL = String.fromCharCode(10);' +
	'  var type = env.type;' +
	'  var title = env.title || "";' +
	'  var options = (env.options || "").split(NL).filter(Boolean);' +
	'  var sys = { role: "system", content: "你是一个答题助手。请根据题目和选项直接给出答案，不要做任何解释，不要加标点。" };' +
	'  var user = "";' +
	'  if (type === "single") {' +
	'    user = "以下是一道单选题，请选出唯一正确选项，只回复选项字母（如B），不要解释。" + NL + title + NL + options.join(NL);' +
	'  } else if (type === "multiple") {' +
	'    user = "以下是一道多选题，请选出所有正确选项，只回复选项字母连写（如AC），不要加任何分隔符或标点，不要解释。" + NL + title + NL + options.join(NL);' +
	'  } else if (type === "judgement") {' +
	'    user = "以下是一道判断题，请判断对错，只回复正确或错误，不要解释。" + NL + title;' +
	'  } else if (type === "completion") {' +
	'    user = "以下是一道填空题，请给出填空答案，只回复答案内容，不要解释。" + NL + title;' +
	'  } else {' +
	'    user = "请回答以下问题，只回复答案，不要解释。" + NL + title + NL + options.join(NL);' +
	'  }' +
	'  return [sys, { role: "user", content: user }];' +
	'}';

/**
 * AI 响应解析 handler 源码字符串（解析 OpenAI 响应并清洗答案）
 *
 * 同样遵守：无 // 注释、无反引号、只用单引号/双引号拼接
 */
const aiResponseHandlerSource =
	'return (res) => {' +
	'  if (!res || !res.choices || !res.choices[0]) { return undefined; }' +
	'  var raw = (res.choices[0].message.content || "").trim();' +
	'  var answer = raw;' +
	'  if (/^(正确|对|true|T|是)$/i.test(raw)) {' +
	'    answer = "正确";' +
	'  } else if (/^(错误|错|false|F|否)$/i.test(raw)) {' +
	'    answer = "错误";' +
	'  }' +
	'  return ["AI生成答案", answer, { ai: true, raw: raw }];' +
	'}';

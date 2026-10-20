# Design System

## Direction

TanStarter Lite uses an original workshop-poster form of neo-brutalism: a warm
paper-like canvas, dense black construction lines, offset printed color fields,
and components that look assembled rather than polished into anonymity. Dark
mode inverts the workshop into a late-night build desk without turning neon.

The system is playful enough to be memorable but disciplined enough for a
developer template. It avoids SaaS-dashboard chrome, glass effects, gradients,
generic bento grids, and decorative code motifs.

## Palette

- Paper: warm ivory in light mode, near-black brown in dark mode.
- Ink: near-black in light mode, warm ivory in dark mode.
- Signal orange: primary actions and decisive emphasis.
- Sun yellow: highlighted structure and selected states.
- Cyan: technical details and secondary fields.
- Leaf green: positive inclusion.
- Lavender: quieter supporting fields.

Color belongs to page-scale fields and purposeful components, not scattered
accents. Text on color fields uses ink for stable contrast.

## Typography

Baloo 2 is the display and UI voice for Latin text. It is heavy, rounded, and
physical without imitating a terminal. Simplified Chinese uses the platform's
rounded sans-serif fallback. Headings are compact and heavy; body copy stays
between 60 and 72 characters per line.

## Components

- Borders are 2px ink lines.
- Interactive and highlighted surfaces use 4px offset hard shadows.
- Corners use a restrained 10px radius; controls may use 8px.
- Buttons visibly depress on activation by moving into their shadow.
- Cards vary in scale and arrangement; equal icon-card grids do not structure
  the page.
- Icons reuse the project's existing Tabler Icons dependency with a consistent
  2px stroke; do not generate custom raster art for navigation or actions.

## Motion

Content is visible before JavaScript. The primary authored moment is the hero
assembly: colored structural pieces settle into alignment while the build path
draws itself. Below-fold transitions are restrained and never required for
comprehension. Reduced-motion users receive an immediate stable composition.

## Responsive Behavior

Desktop uses an asymmetric editorial/workbench composition. Mobile collapses
that composition into one deliberate reading path, keeps controls at least
44px tall, and turns navigation into an accessible disclosure panel.

## Accessibility

Use semantic headings and landmarks, skip navigation, clear focus rings,
adequate contrast in both themes, descriptive control labels, and no
color-only communication.

## Moni Entry Notes

Moni 每笔收入、支出和退款均支持独立的可选备注，记录商家、地点、用途等具体细节。输入“午餐在肯德基吃的 35”时，名称可为“午餐”，备注保留“在肯德基吃的”；AI 不凭空补充信息，多笔账目的备注不串用。

沿用现有草稿编辑、记账表单及详情中的备注位置，支持补充、修改和清空。列表可用次要文字展示摘要，详情可查看完整内容；关键词搜索和自然语言查账包含备注。仅修改备注不触发汇率更新，CSV 与 JSON 备份恢复保留备注。

备注补充仅更新文字规则，不调整 PC 或手机 UI 图。随后使用者于 2026-10-18 确认 UI 并授权素材提取；字标及小票助手已整理，图标复用 Tabler Icons。具体页面对应见 [双端 UI 审查稿](docs/design/moni-v0.1/REVIEW.md)，文件与使用约定见 [素材清单](docs/design/moni-v0.1/assets/README.md)。

2026-10-19 追加：设置页增加“记账权限”卡片，手机与 PC 共用两项单选：“由我确认”（默认）与“直接入账”，选中后由本人明确保存。聊天输入区展示当前档位并可进入设置。沿用原有主题、卡片、字体和按钮，不重新设计素材。微信在确认模式下展示完整草稿并理解使用者的自然语言确认意图；直接入账模式返回已入账回执。常规回复不附加固定网页链接。规则见[记账权限](docs/posting-permissions.md)。

同日补充：普通会话复用同一套意图和确认规则。手机与 PC 的草稿卡保留逐份编辑／确认按钮，并提示未入账草稿不计统计；完整展示后支持自然语言确认或一次确认当前完整草稿。统计与自动入账同轮完成时，当前结果卡显示入账后的可信数据，不增加第二张旧金额卡。无需新增美术素材或改变已批准的布局。

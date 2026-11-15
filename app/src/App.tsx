import { Icon, IconSprite } from "./icons";

export default function App() {
  return (
    <div className="app" data-screen="browse">
      <IconSprite />

      {/* 标题栏 */}
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon id="i-image" size="sm" />
          </span>
          <span className="brand-name">Albumio</span>
        </div>
        <nav className="crumbs">
          <span className="crumb">图片</span>
          <Icon id="i-chev-right" className="crumb-sep" />
          <span className="crumb">2024</span>
          <Icon id="i-chev-right" className="crumb-sep" />
          <span className="crumb cur">京都</span>
        </nav>
        <div className="titlebar-pad" />
        <div className="winbtns">
          <button className="winbtn" title="最小化">
            <Icon id="i-minus" size="xs" />
          </button>
          <button className="winbtn" title="最大化">
            <Icon id="i-expand" size="xs" />
          </button>
          <button className="winbtn close" title="关闭">
            <Icon id="i-x" size="xs" />
          </button>
        </div>
      </header>

      {/* 工具条 */}
      <div className="toolbar">
        <div className="tgroup">
          <button className="ibtn" title="后退" data-tip="">
            <Icon id="i-chev-left" />
            <span className="tip tip-l">
              后退 <kbd>Alt ←</kbd>
            </span>
          </button>
          <button className="ibtn" title="前进" disabled>
            <Icon id="i-chev-right" />
          </button>
          <button className="ibtn" title="上级目录" data-tip="">
            <Icon id="i-up" />
            <span className="tip">
              上级目录 <kbd>Alt ↑</kbd>
            </span>
          </button>
        </div>
        <div className="tsep" />
        <div className="tgroup">
          <div className="seg">
            <button className="seg-item active">
              <Icon id="i-grid" size="sm" />
              文件夹
            </button>
            <button className="seg-item">
              <Icon id="i-timeline" size="sm" />
              时间线
            </button>
          </div>
          <div className="zoomctl">
            <Icon id="i-grid" size="sm" />
            <input className="lr" type="range" min="1" max="5" step="1" defaultValue="2" aria-label="缩略图尺寸" />
          </div>
        </div>
        <div className="tsep" />
        <div className="tgroup">
          <button className="tbtn" title="排序">
            <Icon id="i-sort" size="sm" />
            名称 · 升序
          </button>
        </div>
        <div className="tgroup" style={{ flex: 1, minWidth: 0 }}>
          <label className="search" data-tip="">
            <Icon id="i-search" size="sm" />
            <input placeholder="搜索文件名、标签、相机…" />
            <span className="tip">
              搜索当前目录 <kbd>Ctrl F</kbd>
            </span>
          </label>
        </div>
        <div className="tgroup">
          <button className="tbtn" data-tip="">
            <Icon id="i-layers" size="sm" />
            批量
            <span className="tip">
              批量处理 <kbd>Ctrl E</kbd>
            </span>
          </button>
          <button className="tbtn" data-tip="">
            <Icon id="i-sliders" size="sm" />
            编辑
            <span className="tip">
              编辑当前图片 <kbd>E</kbd>
            </span>
          </button>
          <button className="ibtn" title="全屏看图" data-tip="">
            <Icon id="i-expand" />
            <span className="tip">
              全屏看图 <kbd>Enter</kbd>
            </span>
          </button>
        </div>
      </div>

      {/* 工作区 */}
      <div className="workspace">
        <aside className="sidebar">
          <div className="side-scroll" />
        </aside>
        <div className="stage" />
        <aside className="inspector">
          <div className="rail insp-rail">
            <button className="ibtn" title="展开检查器" data-tip="">
              <Icon id="i-info" />
              <span className="tip tip-side">
                展开检查器 <kbd>Ctrl I</kbd>
              </span>
            </button>
          </div>
          <div className="insp-scroll" />
        </aside>
      </div>

      {/* 状态栏 */}
      <footer className="statusbar">
        <span>
          <span className="sb-num">42</span> 项
        </span>
        <span className="sb-sep" />
        <span>已选 <span className="sb-num">0</span></span>
        <span className="sb-sep" />
        <span>1.24 GB</span>
        <div className="sb-mid" style={{ marginLeft: "var(--ds-space-5)" }}>
          <span className="sb-sep" />
          <span className="name">DSC_0482.JPG</span>
          <span className="sb-num">6000×4000</span>
          <span>JPEG</span>
          <span className="sb-num">8.4 MB</span>
          <span>2024-11-03 16:20</span>
        </div>
        <div className="sb-right">
          <span>索引 <span className="sb-num">42 / 42</span></span>
          <span className="progress"><i /></span>
          <span className="sb-sep" />
          <span>格宽 <span className="sb-num">128</span> px</span>
          <span className="sb-sep" />
          <span>缩放 <span className="sb-num">100%</span></span>
        </div>
      </footer>
    </div>
  );
}

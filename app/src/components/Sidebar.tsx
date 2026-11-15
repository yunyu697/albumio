import { useCallback, useEffect, useRef, useState } from "react";
import {
  diskInfo,
  navRoots,
  quickPlaces,
  subDirs,
  type DiskInfo,
  type NavRoot,
  type SubDir,
} from "../data/source";
import { formatBytes } from "../format";
import { Icon } from "../icons";

interface Props {
  dir: string;
  onOpenDir: (path: string) => void;
  /** 当前目录的元数据进度，用于底部进度条。 */
  statsKnown: number;
  statsTotal: number;
}

const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");

function joinPath(base: string, name: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
}

function isUnder(path: string, root: string): boolean {
  const a = norm(path);
  const b = norm(root);
  return a === b || a.startsWith(b + "\\") || a.startsWith(b + "/");
}

/** 侧栏：快速访问 + 目录树（懒加载，一次只读一层）+ 底部磁盘/进度。 */
export function Sidebar({ dir, onOpenDir, statsKnown, statsTotal }: Props) {
  const [places, setPlaces] = useState<NavRoot[]>([]);
  const [roots, setRoots] = useState<NavRoot[]>([]);
  const [children, setChildren] = useState<Map<string, SubDir[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const childrenRef = useRef(children);
  const inflight = useRef(new Set<string>());

  childrenRef.current = children;

  useEffect(() => {
    let alive = true;
    Promise.all([quickPlaces(), navRoots()]).then(([p, r]) => {
      if (!alive) return;
      setPlaces(p);
      setRoots(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    diskInfo(dir).then((d) => {
      if (alive) setDisk(d);
    });
    return () => {
      alive = false;
    };
  }, [dir]);

  const load = useCallback(async (path: string) => {
    if (childrenRef.current.has(path) || inflight.current.has(path)) return;
    inflight.current.add(path);
    try {
      const list = await subDirs(path);
      setChildren((prev) => new Map(prev).set(path, list));
    } catch {
      setChildren((prev) => new Map(prev).set(path, []));
    } finally {
      inflight.current.delete(path);
    }
  }, []);

  /** 展开当前目录的祖先链，让树能定位到它。 */
  useEffect(() => {
    if (!dir) return;
    const root = roots.find((r) => isUnder(dir, r.path));
    if (!root) return;
    let alive = true;
    (async () => {
      const chain: string[] = [root.path];
      let cur = root.path;
      const rest = dir.slice(root.path.length).split(/[\\/]/).filter(Boolean);
      for (const seg of rest.slice(0, -1)) {
        cur = joinPath(cur, seg);
        chain.push(cur);
      }
      for (const p of chain) {
        if (!alive) return;
        await load(p);
      }
      if (!alive) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of chain) next.add(p);
        return next;
      });
    })();
    return () => {
      alive = false;
    };
  }, [dir, roots, load]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        void load(path);
      }
      return next;
    });
  };

  // 侧栏计数取自已加载层级的"直接图片数"：没展开过的节点不知道就不显示，不猜。
  const counts = new Map<string, number>();
  for (const list of children.values()) {
    for (const kid of list) counts.set(kid.path, kid.images);
  }

  const row = (node: NavRoot, depth: number) => {
    const kids = children.get(node.path);
    const open = expanded.has(node.path);
    const on = norm(dir) === norm(node.path);
    const chevOpacity = kids && kids.length === 0 ? 0 : 1;
    const count = counts.get(node.path);
    return (
      <div
        key={node.path}
        className={`tree-row${on ? " on" : ""}`}
        style={{ paddingLeft: `calc(var(--ds-space-4) + ${depth} * var(--ds-space-6))` }}
        onClick={() => {
          onOpenDir(node.path);
          if (!open) toggle(node.path);
        }}
        title={node.path}
      >
        <Icon
          id={open ? "i-chev-down" : "i-chev-right"}
          size="xs"
          className="chev"
          style={{ opacity: chevOpacity }}
        />
        <Icon id="i-folder" size="sm" className="fi" />
        <span className="tree-label">{node.name}</span>
        {count ? <span className="tree-count">{count}</span> : null}
      </div>
    );
  };

  const branch = (node: NavRoot, depth: number) => (
    <div key={`b:${node.path}`}>
      {row(node, depth)}
      {expanded.has(node.path) &&
        (children.get(node.path) ?? []).map((kid) => branch(kid, depth + 1))}
    </div>
  );

  const used = disk ? 1 - disk.freeBytes / disk.totalBytes : 0;
  const complete = statsTotal > 0 && statsKnown >= statsTotal;

  return (
    <aside className="sidebar">
      <div className="side-scroll">
        <div className="side-section">
          <div className="side-title">
            <span>快速访问</span>
          </div>
          {places.map((p, i) => (
            <div
              key={p.path}
              className={`tree-row${norm(dir) === norm(p.path) ? " on" : ""}`}
              style={{ paddingLeft: "var(--ds-space-4)" }}
              onClick={() => onOpenDir(p.path)}
              title={p.path}
            >
              <span className="chev" />
              <Icon id={i === 0 ? "i-image" : "i-folder"} size="sm" className="fi" />
              <span className="tree-label">{p.name}</span>
            </div>
          ))}
        </div>

        <div className="side-section">
          <div className="side-title">
            <span>文件夹</span>
          </div>
          {roots.map((r) => branch(r, 0))}
        </div>
      </div>

      <div className="side-foot">
        {disk && (
          <div className="disk" title={`${disk.label} · 共 ${formatBytes(disk.totalBytes)}`}>
            <span>{disk.label}</span>
            <span className="disk-bar">
              <i style={{ width: `${Math.max(2, Math.round(used * 100))}%` }} />
            </span>
            <span>{formatBytes(disk.freeBytes)} 可用</span>
          </div>
        )}
        <div className="index-note">
          <span
            className="dot"
            style={complete ? undefined : { background: "var(--ds-color-text-muted)" }}
          />
          已统计 {statsKnown} / {statsTotal}
        </div>
      </div>
    </aside>
  );
}

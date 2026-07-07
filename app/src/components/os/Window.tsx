import React from "react";

/** A rounded system panel: paper body, 1px ink border, soft drop shadow, an
 * inner-top highlight and an optional dotted-grid body texture. The titlebar is
 * a glossy strip with an icon slot, a serif title and a right slot for a
 * tag/chip. Pure presentation — wrap page content, it changes nothing about it. */
export function Window({
  title, icon, right, dotted, bodyStyle, className, style, children,
}: {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  dotted?: boolean;
  bodyStyle?: React.CSSProperties;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div className={`os-window${dotted ? " dotted" : ""}${className ? " " + className : ""}`} style={style}>
      {(title || icon || right) && <WindowTitleBar title={title} icon={icon} right={right} />}
      <div className="os-window-body" style={bodyStyle}>{children}</div>
    </div>
  );
}

export function WindowTitleBar({ title, icon, right }: { title?: React.ReactNode; icon?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="os-titlebar">
      {icon != null && <span className="os-tb-icon" aria-hidden>{icon}</span>}
      {title != null && <span className="os-tb-title">{title}</span>}
      {right != null && <span className="os-tb-right">{right}</span>}
    </div>
  );
}

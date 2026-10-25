import type { DockItem, DockSeparator, DockWrapper } from "dockbar";

type ElementProps<T> = React.DetailedHTMLProps<React.HTMLAttributes<T>, T> & { class?: string };

declare module "react" {
  export namespace JSX {
    interface IntrinsicElements {
      "dock-wrapper": ElementProps<DockWrapper> &
        Partial<Pick<DockWrapper, "allowDragDelete" | "direction" | "disabled" | "easing" | "gap" | "maxRange" | "maxScale" | "padding" | "position" | "size" | "sortable" | "willChange">>;
      "dock-item": ElementProps<DockItem> &
        Partial<Pick<DockItem, "direction" | "easing" | "gap" | "height" | "resizeDuration" | "resizeEase" | "resizeExitDuration" | "size" | "width">>;
      "dock-separator": ElementProps<DockSeparator> &
        Partial<Pick<DockSeparator, "direction" | "size" | "thickness">>;
    }
  }
}

/** Resize a side panel of `container` by dragging `splitter`; `set` gets the new width, undefined on a double click to reset */
export function bindSplitter(splitter: HTMLElement, container: HTMLElement, side: "left" | "right", set: (width: number | undefined) => void, done: () => void): void {
    let dragging = false;
    splitter.addEventListener("pointerdown", (e) => {
        dragging = true;
        splitter.setPointerCapture(e.pointerId);
        splitter.classList.add("active");
    });
    splitter.addEventListener("pointermove", (e) => {
        if (!dragging) {
            return;
        }
        const rect = container.getBoundingClientRect();
        const width = side === "left" ? e.clientX - rect.left : rect.right - e.clientX;
        set(Math.round(Math.min(Math.max(width, 160), rect.width * 0.6)));
    });
    splitter.addEventListener("pointerup", () => {
        dragging = false;
        splitter.classList.remove("active");
        done();
    });
    splitter.addEventListener("dblclick", () => {
        set(undefined);
        done();
    });
}

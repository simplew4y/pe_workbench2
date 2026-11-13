/** Own transcript scrolling; browser scroll events must not re-enable a paused reader. */
const controllers = new WeakMap();

export function getThreadScroll(thread) {
  if (controllers.has(thread)) return controllers.get(thread);
  const atBottom = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 1;
  let following = true;
  let writtenTop = thread.scrollTop;
  let dragging = false;

  thread.addEventListener('scroll', () => {
    // Ignore echoes of our writes, including clamping after a snapshot shrinks.
    if (!dragging && thread.scrollTop !== writtenTop) following = atBottom();
  }, { passive: true });
  thread.addEventListener('wheel', event => {
    // Pause before the wheel's default scrolling and the next render frame.
    if (event.deltaY < 0) following = false;
  }, { passive: true });
  thread.addEventListener('keydown', event => {
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) following = false;
  });
  thread.addEventListener('pointerdown', event => {
    const box = thread.getBoundingClientRect();
    const left = box.left + thread.clientLeft;
    // Detect the actual scrollbar gutter, including a left-hand RTL scrollbar.
    if (event.clientX < left || event.clientX >= left + thread.clientWidth) {
      dragging = true;
      following = false;
    }
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    following = atBottom();
  };
  thread.ownerDocument.addEventListener('pointerup', release);
  thread.ownerDocument.addEventListener('pointercancel', release);
  thread.ownerDocument.defaultView.addEventListener('blur', release);

  const controller = {
    capture(mode) {
      const top = thread.scrollTop;
      // Also catch a scrollbar move whose scroll event has not dispatched yet.
      if (!dragging && top !== writtenTop) following = atBottom();
      if (mode === true) following = true; // Explicit send/navigation only.
      const follow = mode === true || mode === 'follow' && following && !dragging;
      return () => {
        thread.scrollTop = follow ? thread.scrollHeight : top;
        writtenTop = thread.scrollTop;
      };
    },
    reset() {
      following = true;
      writtenTop = thread.scrollTop;
    },
  };
  controllers.set(thread, controller);
  return controller;
}

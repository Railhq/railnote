/**
 * Stub for lottie-web in headless rendering context.
 * Lottie animations are not rendered in the export pipeline —
 * they show as static frames from the node snapshot.
 */
const lottie = {
  loadAnimation: () => ({
    destroy: () => {},
    play: () => {},
    pause: () => {},
    stop: () => {},
    goToAndStop: () => {},
    goToAndPlay: () => {},
    setSpeed: () => {},
    setDirection: () => {},
    getDuration: () => 0,
    totalFrames: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  destroy: () => {},
};

export default lottie;

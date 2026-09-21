// `react-reconciler` ships no types; the render harness (`render-harness.ts`, tests only) uses it loosely.
declare module 'react-reconciler' {
  const Reconciler: (hostConfig: any) => any;
  export default Reconciler;
}
declare module 'react-reconciler/constants.js' {
  export const DefaultEventPriority: number;
  export const NoEventPriority: number;
}

import { isWeb } from '../platform';

/**
 * Classes that apply on the web only, for the `lg:` compositions a screen adds
 * for desktop. On a device a breakpoint class would follow the window (an iPad
 * in landscape is 1024 wide), and the desktop shape is a browser's, so a
 * screen wraps its `lg:` classes in this rather than writing them bare.
 *
 *     <View className={cx('flex-1', web('lg:flex-row'))} />
 *
 * A class, not a hook: the server markup is right at every width, so nothing
 * flashes on hydration.
 */
export const web = (classes: string): string => (isWeb ? classes : '');

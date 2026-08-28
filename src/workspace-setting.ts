/**
 * DefaultWorkspaceSetting — live + persisted on/off flag for per-user default
 * workspace provisioning.
 *
 * Implementation moved to the shared {@link BooleanSetting} (the persisted
 * `{ enabled }` flag is the same for every admin runtime toggle); this module
 * re-exports it under the original name for back-compat.
 */
import { BooleanSetting } from './boolean-setting.ts'

/** Persisted runtime flag backing the "默认用户工作空间" toggle. */
export class DefaultWorkspaceSetting extends BooleanSetting {}
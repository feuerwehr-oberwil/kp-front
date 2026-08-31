import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/** The two incident roles. There is no third one — deployment admin is the ADMIN_SECRET session. */
export type MemberRole = 'editor' | 'viewer'

export interface RoleChoiceProps {
  /** `null` = nothing chosen yet. Only the CREATE form may pass null: for an existing member the
   *  value exists, so the card for the current role is always the selected one. */
  value: MemberRole | null
  onChange: (role: MemberRole) => void
  /** The question, asked about the person by name («Was darf Kunz Bea im Einsatz?»). */
  label: string
  /** One line under the cards, e.g. that the choice can be changed later. */
  hint?: string
  /** A role that cannot be picked right now, with the reason shown on its card
   *  (the last active editor may not be demoted). */
  locked?: { role: MemberRole; reason: string }
}

/**
 * Rolle as an EXPLICIT choice — two cards, no default.
 *
 * The dropdown this replaces defaulted to «Betrachter», which reads as a filled-in field rather
 * than an open question: a tester created three crew accounts without noticing and all three came
 * out read-only, discovered only when somebody could not write during an incident. So the form
 * asks, «Anlegen» stays disabled until it is answered, and each card names the consequence in the
 * operator's terms instead of the role's name alone.
 *
 * Selection is BLUE (`--blue`), never the brand red — red means danger in this product.
 */
export function RoleChoice({ value, onChange, label, hint, locked }: RoleChoiceProps) {
  const C = appConfig.copy.admin.members
  const roles: { role: MemberRole; title: string; means: string }[] = [
    { role: 'editor', title: C.roleEditor, means: C.roleEditorMeans },
    { role: 'viewer', title: C.roleViewer, means: C.roleViewerMeans },
  ]

  return (
    <div className="adm-field adm-rolefield">
      <span className="adm-field-label">
        {label} <span className="adm-field-hint">{C.roleRequired}</span>
      </span>
      <div className="adm-pick" role="radiogroup" aria-label={label}>
        {roles.map(({ role, title, means }) => {
          const on = value === role
          const isLocked = locked?.role === role && !on
          return (
            <button
              key={role}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={isLocked}
              className={`adm-pick-opt${on ? ' on' : ''}`}
              onClick={() => onChange(role)}
            >
              <span className="adm-pick-head">
                <span className="adm-pick-mark" aria-hidden>{on && <Icon id="check" />}</span>
                {title}
              </span>
              <span className="adm-pick-sub">{isLocked ? locked.reason : means}</span>
            </button>
          )
        })}
      </div>
      {hint && <p className="adm-hint">{hint}</p>}
    </div>
  )
}

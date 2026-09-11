/**
 * Resident authorization view data
 * --------------------------------------------------------------------------
 * Authorizations are provider-bound through their resident instance. The
 * Watchfloor must never reuse a different provider's resident state or
 * repository binding while an operator is focused on one provider.
 */

export interface ResidentActivityScopeRow {
  id: string;
  provider: string;
}

export interface ResidentAuthorizationScopeRow {
  resident_instance_id: string;
}

/**
 * Return only the resident instances and authorizations belonging to the
 * selected canonical provider. `null` is the explicit all-provider view.
 */
export function scopeResidentAuthorizationData<
  Resident extends ResidentActivityScopeRow,
  Authorization extends ResidentAuthorizationScopeRow,
>(input: {
  selectedAgentKind: string | null;
  residentActivity: Resident[];
  residentAuthorizations: Authorization[];
}): { residentActivity: Resident[]; residentAuthorizations: Authorization[] } {
  const selected = input.selectedAgentKind?.trim().toLowerCase() ?? null;
  if (!selected) return {
    residentActivity: input.residentActivity,
    residentAuthorizations: input.residentAuthorizations,
  };

  const residentActivity = input.residentActivity.filter(
    (resident) => resident.provider.trim().toLowerCase() === selected,
  );
  const residentIds = new Set(residentActivity.map((resident) => resident.id));
  return {
    residentActivity,
    residentAuthorizations: input.residentAuthorizations.filter(
      (authorization) => residentIds.has(authorization.resident_instance_id),
    ),
  };
}

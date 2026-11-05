const model = 'doubao-seedream-5-0-flash-260915';
// Sanitized account price response verified on 2026-11-04; no credentials.
const charges = ['ToICompletion', 'ToILayerCompletion'].map(Type => ({ Type, Price: 0.12, OriginalPrice: 0.12, UnitCode: '张' }));
const activation = { FoundationModelName: 'doubao-seedream-5-0-flash', DisplayName: 'Doubao Seedream 5.0 Flash', ChargeItems: charges, MultiChargeItems: [{ ChargeItems: charges }] };
module.exports = { model, activation };

export const SLABS_BELOW_500 = [
  { num: 1, min: 1,   max: 100, rate: 0,    color: '#1D9E75', label: 'Free' },
  { num: 2, min: 101, max: 200, rate: 0,    color: '#EF9F27', label: 'Free' },
  { num: 3, min: 201, max: 400, rate: 4.70, color: '#E24B4A', label: '₹4.70' },
  { num: 4, min: 401, max: 500, rate: 6.30, color: '#534AB7', label: '₹6.30' }
];

export const SLABS_ABOVE_500 = [
  { num: 1, min: 1,    max: 100,   rate: 0,     color: '#1D9E75', label: 'Free' },
  { num: 2, min: 101,  max: 400,   rate: 4.70,  color: '#EF9F27', label: '₹4.70' },
  { num: 3, min: 401,  max: 500,   rate: 6.30,  color: '#E24B4A', label: '₹6.30' },
  { num: 4, min: 501,  max: 600,   rate: 8.40,  color: '#534AB7', label: '₹8.40' },
  { num: 5, min: 601,  max: 800,   rate: 9.45,  color: '#185FA5', label: '₹9.45' },
  { num: 6, min: 801,  max: 1000,  rate: 10.50, color: '#0F6E56', label: '₹10.50' },
  { num: 7, min: 1001, max: 99999, rate: 11.55, color: '#993C1D', label: '₹11.55' }
];

export function getSlabs(units) {
  return units <= 500 ? SLABS_BELOW_500 : SLABS_ABOVE_500;
}

export function calculateTNEBBill(units) {
  if (!units || units <= 0) return 0;
  const slabs = getSlabs(units);
  let total = 0;
  for (const slab of slabs) {
    if (units < slab.min) break;
    const inSlab = Math.min(units, slab.max) - slab.min + 1;
    total += inSlab * slab.rate;
  }
  return total;
}

export function getCurrentSlab(units) {
  const slabs = getSlabs(units);
  if (units < 1) return slabs[0];
  return slabs.find(s => units >= s.min && units <= s.max) ?? slabs[slabs.length - 1];
}

export function getDailySlabRate(units) {
  const slab = getCurrentSlab(units);
  return { slab: slab.num, rate: slab.rate };
}

export function calculateSubsidized(units) {
  return calculateTNEBBill(units);
}

export function calculateHighUsage(units) {
  return calculateTNEBBill(units);
}

export function calculateDailyCost(units) {
  return calculateTNEBBill(units);
}

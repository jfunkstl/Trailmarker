// Maps full state names and two-letter abbreviations to their
// ISO 3166-2 code, which OpenStreetMap uses to tag state boundary areas.
const STATES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "District of Columbia": "DC",
};

// Build a lookup that accepts full names ("California"), abbreviations ("CA"),
// and is case-insensitive, and resolves to the OSM ISO3166-2 area tag ("US-CA").
export const STATE_ISO = {};
export const STATE_LIST = Object.keys(STATES).sort();

for (const [name, abbr] of Object.entries(STATES)) {
  STATE_ISO[name] = `US-${abbr}`;
  STATE_ISO[name.toLowerCase()] = `US-${abbr}`;
  STATE_ISO[abbr] = `US-${abbr}`;
  STATE_ISO[abbr.toLowerCase()] = `US-${abbr}`;
}

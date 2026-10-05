package main

// Deliberately excludes customer name, phone, street, building and payment data.
// A district/area (or location where the restaurant requires it) is sufficient
// to evaluate delivery coverage. Actual checkout collects its own full input.
type restaurantPreviewAddress struct {
	Country    string   `json:"country"`
	RegionID   string   `json:"regionId,omitempty"`
	CityID     string   `json:"cityId,omitempty"`
	DistrictID string   `json:"districtId,omitempty"`
	Area       string   `json:"area,omitempty"`
	Latitude   *float64 `json:"latitude,omitempty"`
	Longitude  *float64 `json:"longitude,omitempty"`
}

type restaurantPreviewInput struct {
	Mode      string                     `json:"mode"`
	Items     []restaurantOrderLineInput `json:"items"`
	Address   restaurantPreviewAddress   `json:"address"`
	TableCode string                     `json:"tableCode,omitempty"`
}

func (p restaurantPreviewInput) orderInput() restaurantOrderInput {
	return restaurantOrderInput{Mode: p.Mode, Items: p.Items, TableCode: p.TableCode,
		Address: restaurantAddress{Country: p.Address.Country, RegionID: p.Address.RegionID,
			CityID: p.Address.CityID, DistrictID: p.Address.DistrictID, Area: p.Address.Area,
			Latitude: p.Address.Latitude, Longitude: p.Address.Longitude}}
}

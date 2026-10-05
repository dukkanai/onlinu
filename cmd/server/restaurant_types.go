package main

import "time"

// Restaurant data lives in separate tables in this instance's main database.
// Monetary values are integer minor units, never browser-authoritative totals.
type restaurantSettings struct {
	Brand                   *restaurantBrand         `json:"brand,omitempty"`
	Name                    string                   `json:"name"`
	Description             string                   `json:"description"`
	Address                 string                   `json:"address"`
	Phone                   string                   `json:"phone"`
	LogoURL                 string                   `json:"logoUrl"`
	Currency                string                   `json:"currency"`
	DefaultLanguage         string                   `json:"defaultLanguage"`
	MenuLanguage            string                   `json:"menuLanguage"`
	Demo                    bool                     `json:"demo"`
	AcceptingOrders         bool                     `json:"acceptingOrders"`
	DeliveryEnabled         bool                     `json:"deliveryEnabled"`
	PickupEnabled           bool                     `json:"pickupEnabled"`
	TableEnabled            bool                     `json:"tableEnabled"`
	DeliveryFeeMinor        int64                    `json:"deliveryFeeMinor"`
	DeliveryPricingMode     string                   `json:"deliveryPricingMode,omitempty"`
	DeliveryZones           []restaurantDeliveryZone `json:"deliveryZones,omitempty"`
	DeliveryMinimumMinor    int64                    `json:"deliveryMinimumMinor"`
	DeliveryAreas           []string                 `json:"deliveryAreas"`
	DeliveryRadiusKm        float64                  `json:"deliveryRadiusKm"`
	Latitude                *float64                 `json:"latitude"`
	Longitude               *float64                 `json:"longitude"`
	RequireDeliveryLocation bool                     `json:"requireDeliveryLocation"`
	PickupInstructions      string                   `json:"pickupInstructions"`
	OpeningHours            string                   `json:"openingHours"`
	PaymentInstructions     string                   `json:"paymentInstructions"`
	Country                 string                   `json:"country"`
	PrimaryColor            string                   `json:"primaryColor"`
	AccentColor             string                   `json:"accentColor"`
	BackgroundColor         string                   `json:"backgroundColor"`
	CoverURL                string                   `json:"coverUrl"`
	TaxEnabled              bool                     `json:"taxEnabled"`
	TaxRateBps              int64                    `json:"taxRateBps"`
	TaxNumber               string                   `json:"taxNumber"`
	PaymentMethods          map[string][]string      `json:"paymentMethods"`
}
type restaurantCategory struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Sort int    `json:"sort"`
}
type restaurantOption struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	PriceMinor int64  `json:"priceMinor"`
	Available  bool   `json:"available"`
}
type restaurantItem struct {
	ID          string             `json:"id"`
	CategoryID  string             `json:"categoryId"`
	Name        string             `json:"name"`
	Description string             `json:"description"`
	PriceMinor  int64              `json:"priceMinor"`
	ImageURL    string             `json:"imageUrl"`
	Available   bool               `json:"available"`
	Sort        int                `json:"sort"`
	Options     []restaurantOption `json:"options"`
}
type restaurantTable struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Code   string `json:"code"`
	Active bool   `json:"active"`
}
type restaurantCatalog struct {
	Version    int64                `json:"version"`
	Settings   restaurantSettings   `json:"settings"`
	Categories []restaurantCategory `json:"categories"`
	Items      []restaurantItem     `json:"items"`
	Tables     []restaurantTable    `json:"tables,omitempty"`
}
type restaurantAddress struct {
	Country          string   `json:"country"`
	RegionID         string   `json:"regionId,omitempty"`
	CityID           string   `json:"cityId,omitempty"`
	DistrictID       string   `json:"districtId,omitempty"`
	ID               string   `json:"id,omitempty"`
	Label            string   `json:"label,omitempty"`
	City             string   `json:"city"`
	District         string   `json:"district"`
	Street           string   `json:"street"`
	Building         string   `json:"building"`
	PostalCode       string   `json:"postalCode"`
	AdditionalNumber string   `json:"additionalNumber"`
	NationalAddress  string   `json:"nationalAddress"`
	AddressLine      string   `json:"addressLine"`
	Area             string   `json:"area"`
	Latitude         *float64 `json:"latitude"`
	Longitude        *float64 `json:"longitude"`
}
type restaurantOrderLineInput struct {
	ItemID    string   `json:"itemId"`
	Quantity  int      `json:"quantity"`
	OptionIDs []string `json:"optionIds"`
}
type restaurantOrderInput struct {
	PaymentMethod      string                     `json:"paymentMethod"`
	PaymentProvider    string                     `json:"paymentProvider"`
	Mode               string                     `json:"mode"`
	CustomerName       string                     `json:"customerName"`
	Phone              string                     `json:"phone"`
	Address            restaurantAddress          `json:"address"`
	TableCode          string                     `json:"tableCode"`
	Notes              string                     `json:"notes"`
	Items              []restaurantOrderLineInput `json:"items"`
	ExpectedTotalMinor int64                      `json:"expectedTotalMinor"`
}
type restaurantOrderLine struct {
	ItemID         string             `json:"itemId"`
	Name           string             `json:"name"`
	Quantity       int                `json:"quantity"`
	UnitPriceMinor int64              `json:"unitPriceMinor"`
	Options        []restaurantOption `json:"options"`
	TotalMinor     int64              `json:"totalMinor"`
}
type restaurantQuote struct {
	PaymentMethods   []string              `json:"paymentMethods"`
	Tax              restaurantTaxSummary  `json:"tax"`
	Items            []restaurantOrderLine `json:"items"`
	SubtotalMinor    int64                 `json:"subtotalMinor"`
	DeliveryFeeMinor int64                 `json:"deliveryFeeMinor"`
	TotalMinor       int64                 `json:"totalMinor"`
	Currency         string                `json:"currency"`
	TableName        string                `json:"tableName,omitempty"`
	Demo             bool                  `json:"demo"`
}
type restaurantTableChange struct {
	From string    `json:"from"`
	To   string    `json:"to"`
	At   time.Time `json:"at"`
}
type restaurantOrder struct {
	StockExpiresAt       *time.Time                `json:"stockExpiresAt,omitempty"`
	PreparationStartedAt *time.Time                `json:"preparationStartedAt,omitempty"`
	Cancellation         *restaurantCancellation   `json:"cancellation,omitempty"`
	CancellationHistory  []restaurantCancellation  `json:"cancellationHistory,omitempty"`
	Complaints           []restaurantComplaint     `json:"complaints,omitempty"`
	Payment              restaurantOrderPayment    `json:"payment"`
	Tax                  restaurantTaxSummary      `json:"tax"`
	CourierID            string                    `json:"courierId,omitempty"`
	CourierName          string                    `json:"courierName,omitempty"`
	DeliveryStatus       string                    `json:"deliveryStatus,omitempty"`
	DeliveryEvents       []restaurantDeliveryEvent `json:"deliveryEvents"`
	Number               string                    `json:"number"`
	Version              int64                     `json:"version"`
	Status               string                    `json:"status"`
	Mode                 string                    `json:"mode"`
	CustomerName         string                    `json:"customerName"`
	Phone                string                    `json:"phone"`
	Address              restaurantAddress         `json:"address"`
	TableID              string                    `json:"tableId,omitempty"`
	TableName            string                    `json:"tableName,omitempty"`
	TableChanges         []restaurantTableChange   `json:"tableChanges"`
	Notes                string                    `json:"notes"`
	Items                []restaurantOrderLine     `json:"items"`
	SubtotalMinor        int64                     `json:"subtotalMinor"`
	DeliveryFeeMinor     int64                     `json:"deliveryFeeMinor"`
	TotalMinor           int64                     `json:"totalMinor"`
	Currency             string                    `json:"currency"`
	Demo                 bool                      `json:"demo"`
	CreatedAt            time.Time                 `json:"createdAt"`
	UpdatedAt            time.Time                 `json:"updatedAt"`
}
type restaurantReceipt struct {
	Order         restaurantOrder `json:"order"`
	TrackingToken string          `json:"trackingToken"`
	AccessCode    string          `json:"accessCode"`
}
type restaurantCustomer struct {
	ID          string              `json:"id"`
	Username    string              `json:"username"`
	DisplayName string              `json:"displayName"`
	Phone       string              `json:"phone"`
	Addresses   []restaurantAddress `json:"addresses"`
}
type restaurantCustomerUpdate struct {
	DisplayName string              `json:"displayName"`
	Phone       string              `json:"phone"`
	Addresses   []restaurantAddress `json:"addresses"`
}

// All monetary amounts here are snapshots of the confirmed, gross-priced order.
// They do not assert that a printable order receipt is a certified e-invoice.
type restaurantTaxSummary struct {
	Enabled    bool   `json:"enabled"`
	RateBps    int64  `json:"rateBps"`
	Number     string `json:"number"`
	NetMinor   int64  `json:"netMinor"`
	TaxMinor   int64  `json:"taxMinor"`
	GrossMinor int64  `json:"grossMinor"`
}

type restaurantOrderPayment struct {
	Method      string     `json:"method"`
	Provider    string     `json:"provider"`
	Status      string     `json:"status"`
	PaidAt      *time.Time `json:"paidAt,omitempty"`
	AmountMinor int64      `json:"amountMinor"`
}

type restaurantCourier struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Name         string    `json:"name"`
	Phone        string    `json:"phone"`
	Active       bool      `json:"active"`
	Availability string    `json:"availability"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type restaurantDeliveryEvent struct {
	Status      string    `json:"status"`
	CourierID   string    `json:"courierId,omitempty"`
	CourierName string    `json:"courierName,omitempty"`
	Actor       string    `json:"actor,omitempty"`
	At          time.Time `json:"at"`
}

// Code is a translation key, not a database/provider error or user input.
type restaurantError struct {
	Status int
	Code   string
}

func (e *restaurantError) Error() string { return e.Code }
func restaurantFail(status int, code string) error {
	return &restaurantError{Status: status, Code: code}
}

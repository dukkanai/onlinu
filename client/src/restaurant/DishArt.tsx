export function DishArt({ variant = 0 }: { variant?: number }) {
  return (
    <svg
      className={`rs-dish-art rs-art-${variant % 4}`}
      viewBox="0 0 320 220"
      aria-hidden="true"
    >
      <ellipse
        cx="164"
        cy="187"
        rx="105"
        ry="13"
        fill="#133f36"
        opacity=".10"
      />
      <ellipse cx="160" cy="117" rx="109" ry="77" fill="#fffdf5" />
      <ellipse cx="160" cy="117" rx="92" ry="61" fill="#e7e5d5" />
      <ellipse cx="160" cy="116" rx="86" ry="55" fill="#fbf3df" />
      {variant < 0 ? (
        <g
          fill="none"
          stroke="#93a485"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="160" cy="116" r="29" strokeWidth="2" />
          <path d="M106 87v20q0 12 10 12t10-12V87m-10 0v59m95-59q-16 8-16 29h16m0-29v59" />
          <path d="m150 112 8 8 13-15" stroke="#c6ceba" strokeWidth="3" />
        </g>
      ) : variant % 3 === 0 ? (
        <>
          <path
            d="M99 104Q110 64 141 82L187 150Q146 182 121 142Z"
            fill="#c97538"
          />
          <path
            d="M137 79Q169 60 190 88L219 127Q192 157 169 137Z"
            fill="#e8ad62"
          />
          <path
            d="m123 105 25 34m5-45 24 34m8-22 15 20"
            stroke="#a6542c"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <ellipse cx="196" cy="92" rx="18" ry="13" fill="#7b9b4d" />
          <ellipse cx="107" cy="137" rx="21" ry="12" fill="#527c42" />
          <circle cx="208" cy="135" r="12" fill="#dd7755" />
        </>
      ) : variant % 3 === 1 ? (
        <>
          <path d="M104 102Q106 64 160 65T215 102Z" fill="#dba052" />
          <path d="M106 108Q164 93 216 110L207 121H112Z" fill="#7d9e46" />
          <path d="M109 121H210V137H110Z" fill="#7e4a2e" />
          <path
            d="m109 140 20 10 27-9 28 9 24-11"
            stroke="#e6b644"
            strokeWidth="8"
            fill="none"
          />
          <path d="M109 149H211Q210 166 160 166T109 149" fill="#dba052" />
          <path
            d="m139 82 4 3m22-9 4 3m20 6 4 3m-34 7 4 3"
            stroke="#fff4c8"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <ellipse cx="160" cy="116" rx="61" ry="43" fill="#527a3a" />
          <path
            d="M119 95Q158 91 152 118Q128 142 119 95M163 83Q201 95 178 123Q145 118 163 83M180 123Q213 138 170 153Q152 132 180 123M132 126Q158 117 162 148Q133 155 132 126"
            fill="#9db965"
          />
          <circle cx="128" cy="112" r="12" fill="#d97854" />
          <circle cx="187" cy="113" r="11" fill="#d97854" />
          <circle cx="155" cy="137" r="11" fill="#e9c677" />
          <path
            d="m151 92 11 10-10 11-11-10m32 31 10 10-9 9-10-10"
            fill="#fff3d4"
          />
        </>
      )}
      <path
        d="M39 66Q53 93 42 125M282 87Q267 115 282 144"
        stroke="#90a675"
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="54" cy="57" r="5" fill="#d8ad6c" />
      <circle cx="269" cy="164" r="6" fill="#d8ad6c" />
    </svg>
  );
}

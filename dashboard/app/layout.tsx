import "./globals.css";
export const metadata={title:"Network Monitor",description:"Network monitoring dashboard"};

const linkStyle={color:"#cfe0ff",textDecoration:"none",padding:"4px 10px",borderRadius:999} as const;

export default function RootLayout({children}:{children:React.ReactNode}){
  return (
    <html lang="fa" dir="rtl">
      <body>
        {children}
        <nav style={{position:"fixed",bottom:12,left:"50%",transform:"translateX(-50%)",display:"flex",gap:4,padding:"5px 6px",borderRadius:999,background:"rgba(18,26,45,.94)",border:"1px solid #30415f",zIndex:5,fontSize:13,fontFamily:"Arial,Tahoma,sans-serif"}}>
          <a href="/" style={linkStyle}>داشبورد</a>
          <a href="/inventory" style={linkStyle}>موجودی سیستم‌ها</a>
          <a href="/inventory/unmanaged" style={linkStyle}>بدون Agent</a>
        </nav>
      </body>
    </html>
  );
}

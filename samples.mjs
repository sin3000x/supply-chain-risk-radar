const now = Date.now();
export const sampleStrike = {
  id: 'sample:event:port-strike',
  title: '鹿特丹港：两座码头拟罢工',
  summary: '工会已公告拟停工日期，港方正在调整作业安排。未来 72 小时关注装卸是否暂停。',
  region: '荷兰 · 鹿特丹港',
  geoAnchors: ['PORT_ROTTERDAM'],
};

export const samples = {
  news: {categories:{shipping:{items:[
    {source:'虚构媒体',title:'示例：鹿特丹港工会计划周五在两座码头举行罢工',link:'https://example.com/demo/port-strike',publishedAt:now-3600000,snippet:'谈判仍在继续。工会公布拟停工时间，港方尚未公布最终作业安排。',threat:{category:'infrastructure'},storyMeta:{sourceCount:2}},
    {source:'虚构媒体',title:'示例：监管机构公布新的海关申报要求',link:'https://example.com/demo/customs',publishedAt:now-7200000,snippet:'公告列出拟生效日期及适用货物。',threat:{category:'economic'}},
  ]}}},
  signal:{signals:[
    {id:'sample-port-ops',type:'SHIPPING_DISRUPTION',theater:'西欧',summary:'港方更新作业安排：两座码头已减少周五的集装箱预约时段',detectedAt:now-1200000,severity:'MEDIUM',contributingTypes:['虚构港口作业通告']},
    {id:'sample-transit',type:'SHIPPING_DISRUPTION',theater:'红海',summary:'示例：过去一周通行量较基线下降',detectedAt:now-1800000,severity:'HIGH',contributingTypes:['船舶通行量']},
    {id:'sample-weather',type:'WEATHER_EXTREME',theater:'西太平洋',summary:'示例：台风预警覆盖多处沿海设施',detectedAt:now-2500000,severity:'MEDIUM',contributingTypes:['官方天气预警']},
  ]},
  forecast:{forecasts:[
    {id:'sample-port',domain:'运输',region:'西欧',title:'示例：未来 72 小时，两个码头是否暂停装卸？',scenario:'工会已经发布行动日期，谈判和替代作业安排仍可能改变结果。',updatedAt:now,timeHorizon:'72 小时',trend:'rising',probability:.65,priorProbability:.53,confidence:.7,caseFile:{changeSummary:'正式罢工通知发布后，预测概率从 53% 升至 65%。',supportingEvidence:[{type:'公告',summary:'工会已发布计划时间。'}],counterEvidence:[{type:'谈判',summary:'双方仍有可能达成协议。'}],triggers:['港方确认停止装卸','工会撤销罢工通知']}},
  ]},
};

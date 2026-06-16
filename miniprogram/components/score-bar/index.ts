Component({
  properties: {
    score: { type: Number, value: 0 },
    maxScore: { type: Number, value: 5 },
  },
  data: { fillWidth: '0%' },
  observers: {
    'score, maxScore'(score: number, max: number) {
      this.setData({ fillWidth: `${Math.round((score / max) * 100)}%` })
    },
  },
})

import * as React from 'react';
import {ClipLoader} from 'react-spinners';
import * as vega from 'vega';
import * as vl from 'vega-lite';
import {TopLevelSpec} from 'vega-lite';
import {Encoding} from 'vega-lite/build/src/encoding';
import {InlineData, isNamedData} from 'vega-lite/build/src/data';
import * as vegaTooltip from 'vega-tooltip';
import {SPINNER_COLOR} from '../../constants';
import {Logger} from '../util/util.logger';
import {doVegaQuery} from '../../api/api';
import {VoyagerConfig} from '../../models/config';

export interface VegaLiteProps {
  spec: TopLevelSpec;

  renderer?: 'svg' | 'canvas';

  logger: Logger;

  data: InlineData;

  config: VoyagerConfig;

  viewRunAfter?: (view: vega.View) => any;
}

export interface VegaLiteState {
  isLoading: boolean;
}

const CHART_REF = 'chart';

function loghelper(label: string, contents: any): void {
  console.log(label + ": ", JSON.stringify(contents));
}

function sanitizeAggregate(agg: string): string {
  agg = agg.toLowerCase();
  if (agg === "mean") {
    agg = "avg";
  }
  return agg;
}

var globalId = 0;

export class VegaLite extends React.PureComponent<VegaLiteProps, VegaLiteState> {
  private view: vega.View;
  private size: {width: number, height: number};

  private mountTimeout: number;
  private updateTimeout: number;

  private id: number;

  constructor(props: VegaLiteProps) {
    super(props);
    this.state = {
      isLoading: true
    };
    this.id = globalId++;
  }

  public render() {
    return (
      <div>
        <ClipLoader color={SPINNER_COLOR} loading={this.state.isLoading}/>
        <div className='chart' ref={CHART_REF}/>
        {/* chart is defined in app.scss */}
        <div id="vis-tooltip" className="vg-tooltip"/>
      </div>
    );
  }

  public componentDidMount() {
    if (this.mountTimeout) {
      clearTimeout(this.mountTimeout);
    }
    this.setState({
      isLoading: true
    });
    this.mountTimeout = window.setTimeout(() => {
      this.updateSpec();
      this.runView();
      this.setState({
        isLoading: false
      });
    });
  }

  public componentWillReceiveProps(nextProps: VegaLiteProps) {
    if (nextProps.spec !== this.props.spec) {
      this.setState({
        isLoading: true
      });
      this.size = this.getChartSize();
    }
  }

  public componentDidUpdate(prevProps: VegaLiteProps, prevState: VegaLiteState) {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    this.updateTimeout = window.setTimeout(
      (spec: TopLevelSpec, data: InlineData) => {
        if (prevProps.spec !== spec) {
          const chart = this.refs[CHART_REF] as HTMLElement;
          chart.style.width = this.size.width + 'px';
          chart.style.height = this.size.height + 'px';
          this.updateSpec();
        } else if (prevProps.data !== data) {
          this.bindData();
        }
        this.runView();
        this.setState({
          isLoading: false
        });
      },
      0, this.props.spec, this.props.data
    );
  }

  public componentWillUnmount() {
    if (this.mountTimeout) {
      clearTimeout(this.mountTimeout);
    }

    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    if (this.view) {
      this.view.finalize();
    }
  }

  protected updateSpec() {
    // NOTE: spec used to test warning logger
    // vlSpec = {
    //   "description": "A simple bar chart with embedded data.",
    //   "data": {
    //     "values": [
    //       {"a": "A", "b": 28},
    //       {"a": "B", "b": 55},
    //       {"a": "C", "b": 43},
    //       {"a": "D", "b": 91},
    //       {"a": "E", "b": 81},
    //       {"a": "F", "b": 53},
    //       {"a": "G", "b": 19},
    //       {"a": "H", "b": 87},
    //       {"a": "I", "b": 52}
    //     ]
    //   },
    //   "mark": "bar",
    //   "encoding": {
    //     "x": {"field": "a", "type": "quantitative"},
    //     "y": {"field": "b", "type": "quantitative"}
    //   }
    // };

    const compileOptions = {logger: this.props.logger};
    const deagg = this.deaggAndGetSql(this.props.spec);
    const vlSpec = deagg.newSpec;
    const query = deagg.query;
    this.props.data.values = [];

    try {
      const spec = vl.compile(vlSpec, compileOptions).spec;
      const runtime = vega.parse(spec, vlSpec.config);
      this.view = new vega.View(runtime)
        .logLevel(vega.Warn)
        .initialize(this.refs[CHART_REF] as any)
        .renderer(this.props.renderer || 'canvas')
        .hover();
      vegaTooltip.vega(this.view);

      // FixMe: this should probably be refactored into an action (see src/actions).
      doVegaQuery({query : query}, this.props.config).then(
        response => {
          this.props.data.values = response.rows;
          this.bindData();
          this.runView();
        }
      );
    } catch (err) {
      compileOptions.logger.error(err);
    }
  }

  private isAggregateQuery(encoding: any, possibleEncodings : Array<string>) {
    if(!encoding) {
      return false;
    }
    for(const e of possibleEncodings) {
      if(encoding.hasOwnProperty(e) && encoding[e].hasOwnProperty('aggregate')) {
        return true;
      }
    }
    return false;
  }

  private deaggAndGetSql(spec: TopLevelSpec): any {
    // Takes in a vega-lite spec and returns a deaggregated version, along
    // with an SQL query corresponding to the original spec.
    // The SQL query is what is executed against postgres, and the deaggregated vega-lite
    // spec defines an identity function (data-wise) on the results of that SQL query.
    //
    // FixMe: use TS typing rather than strings to access attrs.

    let query: string = 'SELECT ';
    let groupby: string = '';
    let newSpec: TopLevelSpec = JSON.parse(JSON.stringify(spec))
    const encoding: Encoding<string> = spec['encoding'];
    const possibleEncodings : Array<string> = ['x', 'y', 'row', 'size', 'color']; // FixMe: incomplete.
    const isAggQ: boolean = this.isAggregateQuery(encoding, possibleEncodings);

    for(const e of possibleEncodings) {
      if (!(encoding && encoding.hasOwnProperty(e))) {
        continue;
      }
      if(query !== 'SELECT ') {
        query += ', ';
      }
      if (encoding[e].hasOwnProperty('aggregate')) {
        // Deaggregate x encoding.
        const agg = sanitizeAggregate(encoding[e]['aggregate']);
        query += agg + '(' + encoding[e]['field'] + ')';
        newSpec['encoding'][e]['field'] = agg;
        newSpec['encoding'][e]['aggregate'] = '';
      } else {
        // Non-aggregate field.
        const field = encoding[e]['field'];
        query += field;
        if (isAggQ) {
          // Non-aggregate field, so must be in group by clause if doing aggregate query.
          if (groupby === '') {
            groupby = ' GROUP BY ' + field;
          } else {
            groupby += ', ' + field;
          }
        }
        newSpec['encoding'][e]['field'] = field.toLowerCase();
      }
    }

    query += (' FROM ' + spec.data['name']);
    query += groupby;
    // FixMe: add filters
    query += ';';
    return {newSpec: newSpec, query : query}
  }

  private bindData() {
    const {data, spec} = this.props;
    if (data && isNamedData(spec.data)) {
      this.view.change(spec.data.name,
        vega.changeset()
            .remove(() => true) // remove previous data
            .insert(data.values)
      );
    }
  }

  private runView() {
    try {
      this.view.run();
      if (this.props.viewRunAfter) {
        this.view.runAfter(this.props.viewRunAfter);
      }
    } catch (err) {
      this.props.logger.error(err);
    }
  }

  private getChartSize(): {width: number, height: number} {
    const chart = this.refs[CHART_REF] as HTMLElement;
    const chartContainer = chart.querySelector(this.props.renderer || 'canvas');
    const width = Number(chartContainer.getAttribute('width'));
    const height = Number(chartContainer.getAttribute('height'));
    return {width, height};
  }
}

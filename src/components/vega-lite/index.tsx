import * as React from 'react';
import {ClipLoader} from 'react-spinners';
import * as vega from 'vega';
import * as vl from 'vega-lite';
import {TopLevelSpec} from 'vega-lite';
import {Encoding} from 'vega-lite/build/src/encoding';
import {PositionFieldDef} from 'vega-lite/build/src/fielddef';
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

export class VegaLite extends React.PureComponent<VegaLiteProps, VegaLiteState> {
  private view: vega.View;
  private size: {width: number, height: number};

  private mountTimeout: number;
  private updateTimeout: number;

  constructor(props: VegaLiteProps) {
    super(props);
    this.state = {
      isLoading: true
    };
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

    const {logger} = this.props;
    const deagg = this.deaggAndGetSql(this.props.spec);
    const vlSpec = deagg.newSpec; 
    const query = deagg.query;

    try {
      const spec = vl.compile(vlSpec, logger).spec;
      const runtime = vega.parse(spec, vlSpec.config);
      this.view = new vega.View(runtime)
        .logLevel(vega.Warn)
        .initialize(this.refs[CHART_REF] as any)
        .renderer(this.props.renderer || 'canvas')
        .hover();
      vegaTooltip.vega(this.view);
      this.bindData();

      // FixMe: this should probably be refactored into an action (see src/actions).
      doVegaQuery({'query' : query}, this.props.config).then(
        response => {
          this.view.change(this.props.spec['data']['name'], vega.changeset()
            .insert(response.rows)
          ).run();
        }
      );
    } catch (err) {
      logger.error(err);
    }
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
    let encoding: Encoding<string> = spec['encoding'];
    
    if (encoding && encoding.hasOwnProperty('x')) {
      if (encoding['x'].hasOwnProperty('aggregate')) {
        // Deaggregate x encoding.
        query += encoding['x']['aggregate'] + '(' + encoding['x']['field'] + ')';
        newSpec['encoding']['x']['field'] = encoding['x']['aggregate'].toLowerCase();
        newSpec['encoding']['x']['aggregate'] = '';
      } else {
        // Non-aggregate field, so must be in group by clause.
        const field = encoding['x']['field'];
        query += field;
        if (groupby === '') {
          groupby = ' GROUP BY ' + field; 
        } else {
          groupby += ', ' + field;
        }
        newSpec['encoding']['x']['field'] = field.toLowerCase();
      }
      
      if (encoding.hasOwnProperty('y')) {
        query += ', ';
      }
    }
  
    if (encoding && encoding.hasOwnProperty('y')) {
      if (encoding['y'].hasOwnProperty('aggregate')) {
        // Deaggregate y encoding.
        query += encoding['y']['aggregate'] + '(' + encoding['y']['field'] + ')';
        newSpec['encoding']['y']['field'] = encoding['y']['aggregate'].toLowerCase();
        newSpec['encoding']['y']['aggregate'] = '';
      } else {
        // Non-aggregate field, so must be in group by clause.
        const field = encoding['y']['field'];
        query += field;
        if (groupby === '') {
          groupby = ' GROUP BY ' + field; 
        } else {
          groupby += ', ' + field;
        }
        newSpec['encoding']['y']['field'] = field.toLowerCase();
      }
    }
  
    query += (' FROM ' + spec.data['name']);
    query += groupby;
    //query += ' FROM ' + spec.userMeta;
    // FixMe: use real name
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
